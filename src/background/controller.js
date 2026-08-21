import { PORT_NAME, MSG, STORAGE_PREFIX, tabKey } from '../common/messages.js';
import {
  classifyParty,
  isIpLiteral,
  normalizeHostname,
  siteKeyForHost
} from '../lib/domain.js';
import {
  applyTopLevelNavigation,
  destinationIdentity,
  makeTabState,
  normalizeTabState,
  recordDestination,
  recordFingerprintSignal,
  recordResolvedIp
} from '../lib/tab-state.js';

function transportFromUrl(parsed) {
  switch (parsed.protocol) {
    case 'https:': return 'https';
    case 'http:': return 'http';
    case 'wss:': return 'wss';
    case 'ws:': return 'ws';
    default: return 'other';
  }
}

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

function isIgnorableRequest(tabId, parsed) {
  return !Number.isInteger(tabId) ||
    tabId < 0 ||
    parsed.protocol === 'chrome-extension:';
}

function legacySignal(message) {
  if (typeof message.signal === 'string') return message.signal;
  const legacy = message.signals || {};
  if (legacy.canvas) return 'canvas_readback';
  if (legacy.webgl) return 'webgl_renderer';
  if (legacy.audio) return 'audio_readback';
  return null;
}

const DELIVERY_INTERVAL_MS = 100;

export function createBackgroundController(
  chromeApi,
  { now = () => Date.now(), logger = console } = {}
) {
  const tabs = new Map();
  const portBindings = new Map();
  const subscribers = new Map();
  const persistence = new Map();
  const requestSites = new Map();
  const currentDocuments = new Map();
  const pendingNavigations = new Map();
  const pendingDelivery = new Set();
  let deliveryTimer = null;

  function diagnose(operation, error, tabId) {
    try {
      logger.warn('[DomainScan]', operation, {
        tabId: Number.isInteger(tabId) ? tabId : undefined,
        message: error instanceof Error ? error.message : String(error)
      });
    } catch (_error) {
      // Diagnostics must never affect extension behavior.
    }
  }

  const ready = chromeApi.storage.session.get(null)
    .then((stored) => {
      for (const [key, value] of Object.entries(stored || {})) {
        if (!key.startsWith(STORAGE_PREFIX)) continue;
        const state = normalizeTabState(value, now());
        if (state.tabId >= 0) tabs.set(state.tabId, state);
      }
    })
    .catch((error) => diagnose('storage.session.get', error))
    // Requests observed before the first navigation of a session have no site to
    // belong to, so every open tab is seeded from the browser's own committed URL.
    .then(() => seedOpenTabs())
    .catch((error) => diagnose('tabs.query', error));

  async function seedOpenTabs() {
    if (!chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') return;
    const openTabs = await chromeApi.tabs.query({});
    for (const tab of openTabs || []) {
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) continue;
      if (typeof tab.url !== 'string') continue;
      commitNavigation(tab.id, tab.url);
    }
  }

  let work = ready;
  function enqueue(operation, task) {
    work = work
      .then(task)
      .catch((error) => diagnose(operation, error));
    return work;
  }

  function getOrCreate(tabId) {
    let state = tabs.get(tabId);
    if (!state) {
      state = makeTabState(tabId, now());
      tabs.set(tabId, state);
    }
    return state;
  }

  function persist(state) {
    const previous = persistence.get(state.tabId) || Promise.resolve();
    const next = previous
      .then(() => chromeApi.storage.session.set({ [tabKey(state.tabId)]: state }))
      .catch((error) => diagnose('storage.session.set', error, state.tabId));
    persistence.set(state.tabId, next);
  }

  function pushState(tabId) {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const port of subscribers.get(tabId) || []) {
      try {
        port.postMessage({ type: MSG.STATE, state });
      } catch (error) {
        diagnose('port.postMessage', error, tabId);
      }
    }
  }

  // Accumulation is bursty: a single page can make hundreds of requests, and writing
  // and posting the whole tab state per request costs quadratic serialization for
  // evidence the user cannot read that fast anyway. Bursts are coalesced; anything
  // the user or a navigation triggers is delivered at once.
  function commit(state, { immediate = false } = {}) {
    tabs.set(state.tabId, state);
    if (immediate) {
      deliver(state.tabId);
      return;
    }
    pendingDelivery.add(state.tabId);
    if (deliveryTimer == null) {
      deliveryTimer = setTimeout(() => {
        deliveryTimer = null;
        deliverPending();
      }, DELIVERY_INTERVAL_MS);
    }
  }

  function deliver(tabId) {
    pendingDelivery.delete(tabId);
    const state = tabs.get(tabId);
    if (!state) return;
    pushState(tabId);
    persist(state);
  }

  function deliverPending() {
    for (const tabId of [...pendingDelivery]) deliver(tabId);
  }

  function unbindPort(port) {
    const oldTabId = portBindings.get(port);
    if (oldTabId == null) return;
    const ports = subscribers.get(oldTabId);
    if (ports) {
      ports.delete(port);
      if (ports.size === 0) subscribers.delete(oldTabId);
    }
    portBindings.delete(port);
  }

  function bindPort(port, tabId) {
    unbindPort(port);
    portBindings.set(port, tabId);
    let ports = subscribers.get(tabId);
    if (!ports) {
      ports = new Set();
      subscribers.set(tabId, ports);
    }
    ports.add(port);
    port.postMessage({ type: MSG.STATE, state: getOrCreate(tabId) });
  }

  function onBeforeRequest(details) {
    const { tabId, url, type, requestId, documentId } = details || {};
    if (!url) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;

    const state = getOrCreate(tabId);
    if (type === 'main_frame') {
      // A requested navigation is not a committed one: downloads, cancelled
      // navigations and failed loads never become the tab's site. The document
      // request is still an observed destination of the session it was made from.
      pendingNavigations.set(tabId, {
        host: normalizeHostname(parsed.hostname),
        transport: transportFromUrl(parsed),
        requestId: typeof requestId === 'string' ? requestId : null,
        documentId: typeof documentId === 'string' ? documentId : null,
        ip: null
      });
    } else if (type === 'sub_frame' && typeof documentId === 'string') {
      const documents = currentDocuments.get(tabId);
      if (documents && documents.siteKey === state.siteKey) {
        documents.ids.add(documentId);
      }
    }
    if (typeof requestId === 'string') {
      requestSites.set(requestId, {
        tabId,
        siteKey: state.siteKey,
        host: normalizeHostname(parsed.hostname)
      });
    }
    if (state.paused) return;

    commit(recordDestination(state, {
      value: parsed.hostname,
      party: classifyParty(parsed.hostname, state.pageHost),
      requestType: mapRequestType(type),
      transport: transportFromUrl(parsed)
    }, now()));
  }

  // The tab's own URL is the only trustworthy statement about which site the user
  // is on: it changes when a navigation commits, and never for a download.
  function commitNavigation(tabId, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      leaveTheWeb(tabId);
      return;
    }

    const host = normalizeHostname(parsed.hostname);
    // A pending navigation belongs to one host. Anything else committing in this tab
    // is a different page and must not consume it.
    const pending = pendingNavigations.get(tabId);
    const committed = pending && pending.host === host ? pending : null;
    if (committed) pendingNavigations.delete(tabId);

    let state = applyTopLevelNavigation(getOrCreate(tabId), url, now());
    const identity = destinationIdentity(host);

    // Only an observed request may become a destination; a restored page made none.
    if (committed && identity && !state.paused && !state.destinations[identity.id]) {
      state = recordDestination(state, {
        value: host,
        party: classifyParty(host, state.pageHost),
        requestType: 'document',
        transport: committed.transport
      }, now());
      if (committed.ip) state = recordResolvedIp(state, host, committed.ip, now());
    }

    // Every commit replaces the document a page signal may come from.
    currentDocuments.set(tabId, {
      siteKey: state.siteKey,
      ids: new Set(committed && committed.documentId ? [committed.documentId] : [])
    });
    commit(state, { immediate: true });
  }

  // A tab showing a browser page has no site, so it keeps no evidence either.
  function leaveTheWeb(tabId) {
    pendingNavigations.delete(tabId);
    currentDocuments.delete(tabId);
    const previous = tabs.get(tabId);
    if (!previous || (!previous.siteKey && Object.keys(previous.destinations).length === 0)) return;
    commit({ ...makeTabState(tabId, now()), paused: previous.paused }, { immediate: true });
  }


  function onResponseStarted(details) {
    const { tabId, url, ip, requestId } = details || {};
    if (!url || !ip) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;
    const requestSite = typeof requestId === 'string' ? requestSites.get(requestId) : null;
    if (typeof requestId === 'string') requestSites.delete(requestId);
    const pending = pendingNavigations.get(tabId);
    if (pending && pending.requestId && pending.requestId === requestId &&
        pending.host === normalizeHostname(parsed.hostname)) {
      pending.ip = ip;
    }
    if (!requestSite ||
        requestSite.tabId !== tabId ||
        requestSite.host !== normalizeHostname(parsed.hostname)) {
      return;
    }
    const state = tabs.get(tabId);
    if (!state || state.paused || state.siteKey !== requestSite.siteKey) return;
    const next = recordResolvedIp(state, parsed.hostname, ip, now());
    if (next !== state) commit(next);
  }

  chromeApi.webRequest.onBeforeRequest.addListener(
    (details) => enqueue('webRequest.onBeforeRequest', () => onBeforeRequest(details)),
    { urls: ['<all_urls>'] }
  );
  chromeApi.webRequest.onResponseStarted.addListener(
    (details) => enqueue('webRequest.onResponseStarted', () => onResponseStarted(details)),
    { urls: ['<all_urls>'] }
  );
  const forgetRequest = (operation, details) => {
    enqueue(operation, () => {
      if (details && typeof details.requestId === 'string') {
        requestSites.delete(details.requestId);
      }
    });
  };
  chromeApi.webRequest.onCompleted.addListener(
    (details) => forgetRequest('webRequest.onCompleted', details),
    { urls: ['<all_urls>'] }
  );
  chromeApi.webRequest.onErrorOccurred.addListener(
    (details) => forgetRequest('webRequest.onErrorOccurred', details),
    { urls: ['<all_urls>'] }
  );

  chromeApi.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== PORT_NAME) return;

    port.onMessage.addListener((message) => {
      enqueue('port.onMessage', () => {
        if (!message || typeof message !== 'object') return;
        if (message.type === MSG.HELLO && Number.isInteger(message.tabId)) {
          bindPort(port, message.tabId);
          return;
        }

        const tabId = portBindings.get(port);
        if (tabId == null) return;
        const state = getOrCreate(tabId);
        if (message.type === MSG.SET_PAUSED) {
          commit({ ...state, paused: !!message.paused, updatedAt: now() }, { immediate: true });
        } else if (message.type === MSG.CLEAR) {
          commit({
            ...state,
            destinations: {},
            fingerprint: { signals: {} },
            updatedAt: now()
          }, { immediate: true });
        }
      });
    });

    port.onDisconnect.addListener(() => unbindPort(port));
  });

  chromeApi.runtime.onMessage.addListener((message, sender) => {
    enqueue('runtime.onMessage', () => {
      if (!message || message.type !== MSG.FINGERPRINT) return;
      const tabId = sender && sender.tab && sender.tab.id;
      if (!Number.isInteger(tabId) || tabId < 0) return;
      const state = getOrCreate(tabId);
      if (state.paused) return;
      // A bfcached, prerendered or dying document is not what the tab shows now.
      if (typeof sender.documentLifecycle === 'string' && sender.documentLifecycle !== 'active') return;
      const documents = currentDocuments.get(tabId);
      if (documents && typeof sender.documentId === 'string' && documents.ids.size > 0) {
        if (documents.siteKey !== state.siteKey || !documents.ids.has(sender.documentId)) return;
      } else if (siteKeyOfTopLevelUrl(sender) !== state.siteKey) {
        // Without a known document the only trustworthy binding is the tab's own
        // top-level URL: a frame of any origin may report, an unattributable one
        // may not.
        return;
      }
      const next = recordFingerprintSignal(
        state,
        legacySignal(message),
        sender.frameId,
        now()
      );
      if (next !== state) commit(next);
    });
  });

  function siteKeyOfTopLevelUrl(sender) {
    const url = sender && sender.tab && sender.tab.url;
    if (typeof url !== 'string' || !url) return null;
    try {
      return siteKeyForHost(normalizeHostname(new URL(url).hostname));
    } catch (_error) {
      return null;
    }
  }

  function pendingMatchesTab(tabId, url) {
    const pending = pendingNavigations.get(tabId);
    if (!pending) return false;
    try {
      return pending.host === normalizeHostname(new URL(url).hostname);
    } catch (_error) {
      return false;
    }
  }

  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const change = changeInfo || {};
    const changedUrl = typeof change.url === 'string' ? change.url : null;
    const tabUrl = tab && typeof tab.url === 'string' ? tab.url : null;
    // Titles, favicons and audio state say nothing about where the tab is. A reload
    // keeps the URL, so a finished load of a document we requested counts too.
    if (!changedUrl && !(change.status === 'complete' && tabUrl)) return;
    enqueue('tabs.onUpdated', () => {
      if (changedUrl) {
        commitNavigation(tabId, changedUrl);
        return;
      }
      if (pendingMatchesTab(tabId, tabUrl)) commitNavigation(tabId, tabUrl);
    });
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    enqueue('tabs.onRemoved', async () => {
      tabs.delete(tabId);
      currentDocuments.delete(tabId);
      pendingNavigations.delete(tabId);
      pendingDelivery.delete(tabId);
      for (const [requestId, requestSite] of requestSites) {
        if (requestSite.tabId === tabId) requestSites.delete(requestId);
      }
      const ports = subscribers.get(tabId);
      if (ports) {
        for (const port of ports) portBindings.delete(port);
        subscribers.delete(tabId);
      }
      const pendingWrite = persistence.get(tabId);
      if (pendingWrite) await pendingWrite;
      await chromeApi.storage.session.remove(tabKey(tabId));
      persistence.delete(tabId);
    });
  });

  function enableSidePanelOnActionClick() {
    return chromeApi.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => diagnose('sidePanel.setPanelBehavior', error));
  }

  chromeApi.runtime.onInstalled.addListener(enableSidePanelOnActionClick);
  chromeApi.runtime.onStartup.addListener(enableSidePanelOnActionClick);
  enableSidePanelOnActionClick();

  return {
    ready,
    getState(tabId) {
      return tabs.get(tabId);
    },
    async flush() {
      await work;
      if (deliveryTimer != null) {
        clearTimeout(deliveryTimer);
        deliveryTimer = null;
      }
      deliverPending();
      await Promise.all([...persistence.values()]);
    }
  };
}
