// DomainScan — MV3 background service worker (type: "module").
//
// Observation-only capture: watches chrome.webRequest to build a per-tab set of
// Destinations, tracks page context / fingerprint signals, and serves state to the
// side panel over a long-lived port. See docs/ARCHITECTURE.md for the binding contract.
//
// This module re-executes on every service-worker wake, so all durable state is
// mirrored into chrome.storage.session and rehydrated at load time.

import { PORT_NAME, MSG, STORAGE_PREFIX, tabKey } from '../common/messages.js';
import { isIpLiteral, classifyParty } from '../lib/domain.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Map<number, TabState>} tabId -> TabState */
const tabs = new Map();

/** @type {Map<number, chrome.runtime.Port>} tabId -> connected panel port */
const ports = new Map();

/** Create a blank per-tab state. */
function makeTabState(tabId) {
  return {
    tabId,
    pageUrl: null,
    pageHost: null,
    destinations: {},
    fingerprint: { canvas: false, webgl: false, audio: false, firstSeen: null },
    paused: false,
    updatedAt: Date.now()
  };
}

/** Get (or lazily create) the state for a tab. */
function getTabState(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = makeTabState(tabId);
    tabs.set(tabId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Persistence + push (single helper so storage and the port never drift)
// ---------------------------------------------------------------------------

function persist(state) {
  try {
    chrome.storage.session.set({ [tabKey(state.tabId)]: state }).catch(() => {});
  } catch (_e) {
    // Never throw out of a listener.
  }
}

function pushState(tabId) {
  const port = ports.get(tabId);
  const state = tabs.get(tabId);
  if (!port || !state) return;
  try {
    port.postMessage({ type: MSG.STATE, state });
  } catch (_e) {
    // Port may have disconnected between checks; ignore.
  }
}

/** Persist a tab's state AND push it to its connected panel port. */
function commit(state) {
  state.updatedAt = Date.now();
  persist(state);
  pushState(state.tabId);
}

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

/** Map a URL scheme to the contract's transport value. */
function transportFromUrl(parsed) {
  switch (parsed.protocol) {
    case 'https:': return 'https';
    case 'http:': return 'http';
    case 'wss:': return 'wss';
    case 'ws:': return 'ws';
    default: return 'other';
  }
}

/** Map a chrome.webRequest ResourceType to the contract's requestType. */
function mapRequestType(type) {
  switch (type) {
    case 'main_frame':
    case 'sub_frame': return 'document';
    case 'image': return 'image';
    case 'script': return 'script';
    case 'stylesheet': return 'style';
    case 'xmlhttprequest': return 'fetch';
    case 'ping':
    case 'csp_report': return 'beacon';
    case 'media': return 'media';
    case 'font': return 'font';
    case 'websocket': return 'websocket';
    default: return 'other';
  }
}

/** True for requests we never record (not tab-bound, or our own extension pages). */
function isIgnorableRequest(tabId, parsed) {
  if (typeof tabId !== 'number' || tabId < 0) return true;
  if (parsed.protocol === 'chrome-extension:') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Capture: chrome.webRequest (non-blocking, observation only)
// ---------------------------------------------------------------------------

/** Record / dedup a destination onto the tab state. */
function recordDestination(state, parsed, resourceType) {
  const value = (parsed.hostname || '').toLowerCase();
  if (!value) return;

  const kind = isIpLiteral(value) ? 'ip' : 'host';
  const id = `${kind}|${value}`;
  const now = Date.now();

  const existing = state.destinations[id];
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    // firstSeen stays the earliest; fill ip if it becomes known for an ip-kind entry.
    if (kind === 'ip' && !existing.ip) existing.ip = value;
    return;
  }

  state.destinations[id] = {
    id,
    kind,
    value,
    party: classifyParty(value, state.pageHost),
    requestType: mapRequestType(resourceType),
    transport: transportFromUrl(parsed),
    ip: kind === 'ip' ? value : null,
    firstSeen: now,
    lastSeen: now,
    count: 1
  };
}

/** onBeforeRequest: the capture entry point (fires for every request). */
function onBeforeRequest(details) {
  try {
    const { tabId, url, type } = details;
    if (!url) return;

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;

    const state = getTabState(tabId);

    // A top-level document request begins a fresh page session for this tab:
    // update page context and reset destinations (they belong to the current page).
    if (type === 'main_frame') {
      state.pageUrl = url;
      state.pageHost = (parsed.hostname || '').toLowerCase();
      state.destinations = {};
    }

    // Paused tabs keep existing destinations and keep serving state, but record nothing new.
    if (state.paused) {
      if (type === 'main_frame') commit(state); // page context still moved forward
      return;
    }

    recordDestination(state, parsed, type);
    commit(state);
  } catch (_e) {
    // Listeners must never throw.
  }
}

/** onResponseStarted: the only place details.ip is reliably present. */
function onResponseStarted(details) {
  try {
    const { tabId, url, ip } = details;
    if (!ip || !url) return;

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_e) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;

    const state = tabs.get(tabId);
    if (!state) return;

    const value = (parsed.hostname || '').toLowerCase();
    if (!value) return;
    const kind = isIpLiteral(value) ? 'ip' : 'host';
    const id = `${kind}|${value}`;

    const dest = state.destinations[id];
    if (!dest) return; // Only enrich destinations we already captured.
    if (dest.ip) return; // ip already known (always true for ip-kind entries).

    dest.ip = ip;
    dest.lastSeen = Date.now();
    commit(state);
  } catch (_e) {
    // Listeners must never throw.
  }
}

chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'] });
chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['<all_urls>'] });

// ---------------------------------------------------------------------------
// Port protocol: long-lived connection with the side panel
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    try {
      switch (msg.type) {
        case MSG.HELLO: {
          if (typeof msg.tabId !== 'number') break;
          boundTabId = msg.tabId;
          ports.set(boundTabId, port);
          // Immediately reply with current state for this tab.
          port.postMessage({ type: MSG.STATE, state: getTabState(boundTabId) });
          break;
        }
        case MSG.SET_PAUSED: {
          if (boundTabId == null) break;
          const state = getTabState(boundTabId);
          state.paused = !!msg.paused;
          commit(state);
          break;
        }
        case MSG.CLEAR: {
          if (boundTabId == null) break;
          const state = getTabState(boundTabId);
          state.destinations = {}; // keep pageHost / pageUrl / fingerprint / paused
          commit(state);
          break;
        }
        default:
          break;
      }
    } catch (_e) {
      // Ignore malformed messages.
    }
  });

  port.onDisconnect.addListener(() => {
    if (boundTabId != null && ports.get(boundTabId) === port) {
      ports.delete(boundTabId);
    }
  });
});

// ---------------------------------------------------------------------------
// Fingerprint signals from the content relay (one-shot messages)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== MSG.FINGERPRINT) return;
  try {
    const tabId = sender && sender.tab ? sender.tab.id : undefined;
    if (typeof tabId !== 'number' || tabId < 0) return;

    const state = getTabState(tabId);
    const signals = msg.signals || {};
    let changed = false;
    for (const key of ['canvas', 'webgl', 'audio']) {
      if (signals[key] && !state.fingerprint[key]) {
        state.fingerprint[key] = true;
        changed = true;
      }
    }
    if (changed) {
      if (state.fingerprint.firstSeen == null) state.fingerprint.firstSeen = Date.now();
      commit(state);
    }
  } catch (_e) {
    // Never throw out of a listener.
  }
  // No async response; return undefined so the message channel closes.
});

// ---------------------------------------------------------------------------
// Tab cleanup
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  ports.delete(tabId);
  try {
    chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
  } catch (_e) {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Rehydration: survive service-worker restarts
// ---------------------------------------------------------------------------

/** Union canvas/webgl/audio flags and keep the earliest firstSeen. */
function mergeFingerprint(a, b) {
  const x = a || {};
  const y = b || {};
  const times = [x.firstSeen, y.firstSeen].filter((t) => typeof t === 'number');
  return {
    canvas: !!(x.canvas || y.canvas),
    webgl: !!(x.webgl || y.webgl),
    audio: !!(x.audio || y.audio),
    firstSeen: times.length ? Math.min(...times) : null
  };
}

/** Coerce a possibly-partial stored object into a well-formed TabState. */
function normalizeState(s) {
  return {
    tabId: s.tabId,
    pageUrl: s.pageUrl || null,
    pageHost: s.pageHost || null,
    destinations: s.destinations && typeof s.destinations === 'object' ? s.destinations : {},
    fingerprint: mergeFingerprint(s.fingerprint, null),
    paused: !!s.paused,
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now()
  };
}

/**
 * Merge a persisted state with any live state that a listener created during the
 * (async) rehydration window, so nothing accumulated is lost.
 */
function reconcile(stored, live) {
  if (!stored) return live;
  if (!live) return normalizeState(stored);

  // A live top-level navigation to a different host means a new page session began
  // while we were rehydrating — the live state wins wholesale (don't resurrect the
  // previous page's destinations).
  if (live.pageHost && stored.pageHost && live.pageHost !== stored.pageHost) {
    return live;
  }

  return {
    tabId: live.tabId,
    pageUrl: live.pageUrl || stored.pageUrl || null,
    pageHost: live.pageHost || stored.pageHost || null,
    destinations: Object.assign({}, stored.destinations || {}, live.destinations || {}),
    fingerprint: mergeFingerprint(stored.fingerprint, live.fingerprint),
    paused: !!(stored.paused || live.paused),
    updatedAt: Date.now()
  };
}

async function rehydrate() {
  let all;
  try {
    all = await chrome.storage.session.get(null);
  } catch (_e) {
    return;
  }
  if (!all) return;

  for (const [key, stored] of Object.entries(all)) {
    if (!key.startsWith(STORAGE_PREFIX)) continue;
    if (!stored || typeof stored !== 'object' || typeof stored.tabId !== 'number') continue;
    tabs.set(stored.tabId, reconcile(stored, tabs.get(stored.tabId)));
  }

  // A panel may have connected (and been served a not-yet-rehydrated state) during
  // rehydration — refresh every connected port with the reconciled state.
  for (const tabId of ports.keys()) pushState(tabId);
}

// ---------------------------------------------------------------------------
// Lifecycle: side-panel wiring + rehydration
// ---------------------------------------------------------------------------

function enableSidePanelOnActionClick() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch (_e) {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnActionClick();
  rehydrate();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick();
  rehydrate();
});

// Runs on every service-worker wake (onStartup only fires at browser start).
rehydrate();
