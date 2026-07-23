// DomainScan side panel controller.
// Runs as a real MV3 extension page (talks to the background over a long-lived port) and as a
// plain file/http page in "demo mode" (seeds sample data, all controls work locally).

import { MSG } from '../common/messages.js';
import { t } from '../common/strings.js';
import { registrableDomain } from '../lib/domain.js';
import { summarizeFingerprint } from '../lib/fingerprint.js';
import { createPanelConnection } from './connection.js';
import {
  buildDestinationRows,
  collectVisibleDomains,
  collectVisibleIps
} from './view-model.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const IS_DEMO = typeof chrome === 'undefined' || !(chrome.runtime && chrome.runtime.connect);

let connection = null;

// Current TabState we render from (null until first STATE in live mode).
let state = null;

// UI-local state (never sent to the background).
const ui = {
  mode: 'exact',        // 'exact' | 'collapse' | 'registrable'
  query: '',
  selected: Object.create(null), // rowKey -> display value
  connectionStatus: IS_DEMO ? 'connected' : 'connecting'
};

// ---------------------------------------------------------------------------
// Element handles
// ---------------------------------------------------------------------------
const el = {
  brandName: document.getElementById('brand-name'),
  live: document.getElementById('live'),
  liveLabel: document.getElementById('live-label'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsLabel: document.getElementById('settings-label'),
  settingsMenu: document.getElementById('settings-menu'),
  togglePause: document.getElementById('toggle-pause'),
  clearBtn: document.getElementById('clear-btn'),
  eyebrow: document.getElementById('eyebrow'),
  siteHost: document.getElementById('site-host'),
  siteCount: document.getElementById('site-count'),
  fpNote: document.getElementById('fp-note'),
  fpTitle: document.getElementById('fp-title'),
  fpTag: document.getElementById('fp-tag'),
  fpBody: document.getElementById('fp-body'),
  signalList: document.getElementById('signal-list'),
  searchLabel: document.getElementById('search-label'),
  search: document.getElementById('search'),
  modeLabel: document.getElementById('mode-label'),
  segButtons: Array.from(document.querySelectorAll('.seg-btn')),
  modeHelp: document.getElementById('mode-help'),
  list: document.getElementById('list'),
  toast: document.getElementById('toast'),
  copyDomains: document.getElementById('copy-domains'),
  copyIps: document.getElementById('copy-ips'),
  copySelected: document.getElementById('copy-selected')
};

const MODE_HINT = {
  exact: 'modeExactHint',
  collapse: 'modeCollapseHint',
  registrable: 'modeRegistrableHint'
};
const MODE_SEG = { exact: 'modeExact', collapse: 'modeCollapse', registrable: 'modeRegistrable' };
const PARTY_KEY = { first: 'partyFirst', third: 'partyThird', ip: 'partyDirectIp' };
const SIGNAL_KEY = {
  canvas_readback: 'signalCanvasReadback',
  webgl_renderer: 'signalWebglRenderer',
  audio_readback: 'signalAudioReadback',
  timezone: 'signalTimezone',
  language: 'signalLanguage',
  geolocation: 'signalGeolocation',
  ua_high_entropy: 'signalUaHighEntropy'
};

// ---------------------------------------------------------------------------
// Static strings (everything user-facing comes from t())
// ---------------------------------------------------------------------------
function applyStaticStrings() {
  if (!IS_DEMO && chrome.i18n && chrome.i18n.getUILanguage) {
    const language = chrome.i18n.getUILanguage();
    document.documentElement.lang = language && language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  }
  el.brandName.textContent = t('appName');
  el.settingsLabel.textContent = t('settings');
  el.settingsBtn.setAttribute('title', t('settings'));
  el.clearBtn.textContent = t('clearList');
  el.eyebrow.textContent = t('activeTab');
  el.searchLabel.textContent = t('searchPlaceholder');
  el.search.setAttribute('placeholder', t('searchPlaceholder'));
  el.search.setAttribute('aria-label', t('searchPlaceholder'));
  el.modeLabel.textContent = t('display');
  el.segButtons.forEach((b) => {
    b.textContent = t(MODE_SEG[b.dataset.mode]);
  });
  el.copyDomains.textContent = t('copyDomains');
  el.copyIps.textContent = t('copyIps');
}

// ---------------------------------------------------------------------------
// Sample data for demo mode (matches docs/ARCHITECTURE.md)
// ---------------------------------------------------------------------------
function sampleState() {
  const base = Date.now();
  const defs = [
    ['host', 'news.example', 'first', 'document', 'https'],
    ['host', 'img.news.example', 'first', 'image', 'https'],
    ['host', 'static.edge.test', 'third', 'script', 'https'],
    ['host', 'analytics.vendor.test', 'third', 'fetch', 'https'],
    ['host', 'pixel.metrics.test', 'third', 'beacon', 'https'],
    ['host', 'stream.media.test', 'third', 'websocket', 'wss'],
    ['ip', '203.0.113.42', 'ip', 'other', 'https']
  ];
  const destinations = Object.create(null);
  defs.forEach(([kind, value, party, requestType, transport], i) => {
    const id = kind + '|' + value;
    destinations[id] = {
      id, kind, value, party, requestType, transport,
      ips: kind === 'host' && value === 'news.example'
        ? { '203.0.113.10': { value: '203.0.113.10', firstSeen: base, lastSeen: base, count: 1 } }
        : {},
      firstSeen: base + i,
      lastSeen: base + i,
      count: 1
    };
  });
  return {
    tabId: -1,
    siteKey: 'example',
    pageUrl: 'https://news.example/',
    pageHost: 'news.example',
    destinations,
    fingerprint: {
      signals: {
        canvas_readback: { key: 'canvas_readback', count: 1, firstSeen: base, lastSeen: base, frameIds: [0] },
        webgl_renderer: { key: 'webgl_renderer', count: 1, firstSeen: base, lastSeen: base, frameIds: [0] }
      }
    },
    paused: false,
    updatedAt: base
  };
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------
function destinationsArray() {
  if (!state || !state.destinations) return [];
  return Object.values(state.destinations).sort((a, b) => a.firstSeen - b.firstSeen);
}

/**
 * Rows for the current view (mode + search). Modes transform the VIEW only —
 * nothing in state.destinations is mutated or removed.
 * @returns {{key:string, display:string, kind:string, party:string, requestType:string, grouped:number}[]}
 */
function buildRows() {
  return buildDestinationRows(state, { mode: ui.mode, query: ui.query });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  renderHeader();
  renderFingerprint();
  renderModeHelp();
  renderList();
  updateCopySelected();
}

function renderHeader() {
  const paused = !!(state && state.paused);
  const disconnected = !IS_DEMO && ui.connectionStatus !== 'connected';
  el.live.classList.toggle('paused', paused || disconnected);
  const statusText = disconnected ? t('reconnecting') : paused ? t('paused') : t('recording');
  el.liveLabel.textContent = statusText;
  el.live.setAttribute('aria-label', statusText);
  el.togglePause.textContent = paused ? t('resumeCapture') : t('pauseCapture');
  el.togglePause.disabled = disconnected;
  el.clearBtn.disabled = disconnected;

  el.siteHost.textContent = (state && state.pageHost) || '';

  const total = destinationsArray().length;
  el.siteCount.textContent = '';
  const strong = document.createElement('b');
  strong.textContent = String(total);
  el.siteCount.append(strong, ' ' + t('uniqueDestinations'));
}

function renderFingerprint() {
  const signals = state && state.fingerprint && state.fingerprint.signals;
  const summary = summarizeFingerprint(signals);
  el.fpNote.hidden = summary.observed.length === 0;
  if (summary.observed.length === 0) return;

  if (summary.possibleFingerprinting) {
    el.fpTitle.textContent = t('fingerprintTitle');
    el.fpTag.textContent = t('fingerprintTag');
    el.fpBody.textContent = t('fingerprintBody');
  } else if (summary.locationRequested) {
    el.fpTitle.textContent = t('locationTitle');
    el.fpTag.textContent = t('apiObservationTag');
    el.fpBody.textContent = t('locationBody');
  } else {
    el.fpTitle.textContent = t('environmentTitle');
    el.fpTag.textContent = t('apiObservationTag');
    el.fpBody.textContent = t('environmentBody');
  }

  el.signalList.textContent = '';
  for (const signal of summary.observed) {
    const item = document.createElement('li');
    item.textContent = t(SIGNAL_KEY[signal]);
    el.signalList.appendChild(item);
  }
}

function renderModeHelp() {
  const count = buildRows().length;
  el.modeHelp.textContent = '';
  el.modeHelp.append(
    t(MODE_HINT[ui.mode]) + ' ',
    hint(t('showingDestinations', { count }))
  );
}

function hint(text) {
  const span = document.createElement('span');
  span.className = 'muted';
  span.textContent = '· ' + text;
  return span;
}

function renderList() {
  const rows = buildRows();
  el.list.textContent = '';

  if (rows.length === 0) {
    el.list.appendChild(emptyRow());
    return;
  }
  rows.forEach((r, i) => el.list.appendChild(rowNode(r, i)));
}

function emptyRow() {
  const li = document.createElement('li');
  li.className = 'empty';
  const total = destinationsArray().length;
  if (total === 0) {
    const b = document.createElement('b');
    b.textContent = t('emptyTitle');
    li.append(b, t('emptyBody'));
  } else {
    // No destinations match the current search. Communicated with existing strings only.
    li.textContent = t('showingDestinations', { count: 0 });
  }
  return li;
}

function rowNode(r, i) {
  const li = document.createElement('li');
  li.className = 'row' + (r.party === 'third' ? ' third' : '');

  const cbId = 'cb-' + i;
  const isIp = r.kind === 'ip';

  // selection checkbox
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'cb';
  cb.id = cbId;
  cb.checked = ui.selected[r.key] != null;
  cb.dataset.key = r.key;
  cb.dataset.value = r.display;
  cb.setAttribute('aria-label', t('selectRow', { host: r.display }));
  li.appendChild(cb);

  // main column
  const main = document.createElement('div');
  main.className = 'row-main';

  const host = document.createElement('label');
  host.className = 'host' + (isIp ? ' ip' : ui.mode === 'exact' ? ' exact' : '');
  host.setAttribute('for', cbId);
  appendHostMarkup(host, r.display, isIp);
  main.appendChild(host);

  const sub = document.createElement('p');
  sub.className = 'sub';

  const party = document.createElement('span');
  party.className = 'party party-' + r.party;
  const mk = document.createElement('span');
  mk.className = 'mk';
  mk.setAttribute('aria-hidden', 'true');
  party.append(mk, t(PARTY_KEY[r.party]));
  sub.appendChild(party);

  sub.appendChild(sep());

  const rtype = document.createElement('span');
  rtype.className = 'rtype';
  rtype.textContent = r.requestTypes.map((type) => t('requestType_' + type)).join(', ');
  sub.appendChild(rtype);

  if (r.grouped > 1) {
    sub.appendChild(sep());
    const g = document.createElement('span');
    g.className = 'grouped';
    // count only — no invented string; the shown-count already explains grouping
    g.textContent = '×' + r.grouped;
    sub.appendChild(g);
  }

  main.appendChild(sub);

  if (!isIp && r.ips.length > 0) {
    const details = document.createElement('details');
    details.className = 'ip-details';
    const summary = document.createElement('summary');
    summary.textContent = t('resolvedIps', { count: r.ips.length });
    const addresses = document.createElement('ul');
    addresses.className = 'ip-addresses';
    for (const address of r.ips) {
      const item = document.createElement('li');
      item.textContent = address;
      addresses.appendChild(item);
    }
    details.append(summary, addresses);
    main.appendChild(details);
  }
  li.appendChild(main);

  // per-row copy
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-btn';
  copy.dataset.value = r.display;
  copy.dataset.kind = r.kind;
  copy.setAttribute('aria-label', t('copyRow', { host: r.display }));

  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = t('copy');

  const done = document.createElement('span');
  done.className = 'done';
  done.setAttribute('aria-hidden', 'true');
  done.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>';

  copy.append(txt, done);
  li.appendChild(copy);

  return li;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'sep';
  s.setAttribute('aria-hidden', 'true');
  s.textContent = '·';
  return s;
}

/**
 * Host label markup.
 *  - exact: literal host, uniform weight.
 *  - collapse: full host with the subdomain prefix de-emphasized, registrable part emphasized.
 *  - registrable: value is already the registrable domain (or IP) — shown whole.
 */
function appendHostMarkup(node, display, isIp) {
  if (isIp || ui.mode !== 'collapse') {
    node.textContent = display;
    return;
  }
  const reg = registrableDomain(display);
  if (!reg || display === reg || !display.endsWith(reg) || display.length <= reg.length) {
    node.textContent = display;
    return;
  }
  const prefix = display.slice(0, display.length - reg.length); // includes trailing dot
  const pre = document.createElement('span');
  pre.className = 'pre';
  pre.textContent = prefix;
  node.append(pre, reg);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function selectedValues() {
  return Object.values(ui.selected);
}

function updateCopySelected() {
  const n = selectedValues().length;
  el.copySelected.textContent = t('copySelectedCount', { count: n });
  el.copySelected.disabled = n === 0;
}

// ---------------------------------------------------------------------------
// Clipboard + announcements
// ---------------------------------------------------------------------------
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  return legacyCopy(text);
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

let toastTimer = null;
function announce(message) {
  el.toast.textContent = message;
  el.toast.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 2600);
}

function dedupe(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function copyBulk(values, copiedKey) {
  const clean = dedupe(values);
  if (clean.length === 0) {
    announce(t('copyEmpty'));
    return;
  }
  const ok = await copyText(clean.join('\n'));
  announce(ok ? t(copiedKey, { count: clean.length }) : t('copyEmpty'));
}

// current visible rows split by kind
function visibleByKind(kind) {
  const rows = buildRows();
  return kind === 'ip' ? collectVisibleIps(rows) : collectVisibleDomains(rows);
}

// ---------------------------------------------------------------------------
// Control message helpers (live vs demo)
// ---------------------------------------------------------------------------
function setPaused(paused) {
  if (IS_DEMO) {
    if (state) { state.paused = paused; }
    render();
  } else if (connection) {
    connection.post({ type: MSG.SET_PAUSED, paused });
  }
}

function clearTab() {
  ui.selected = Object.create(null);
  if (IS_DEMO) {
    if (state) { state.destinations = Object.create(null); }
    render();
  } else if (connection) {
    connection.post({ type: MSG.CLEAR });
  }
}

// ---------------------------------------------------------------------------
// Settings menu
// ---------------------------------------------------------------------------
function menuOpen() {
  return !el.settingsMenu.hidden;
}
function openMenu() {
  el.settingsMenu.hidden = false;
  el.settingsBtn.setAttribute('aria-expanded', 'true');
  const first = el.settingsMenu.querySelector('.menu-item');
  if (first) first.focus();
}
function closeMenu(returnFocus) {
  el.settingsMenu.hidden = true;
  el.settingsBtn.setAttribute('aria-expanded', 'false');
  if (returnFocus) el.settingsBtn.focus();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  // Search
  el.search.addEventListener('input', () => {
    ui.query = el.search.value;
    renderList();
    renderModeHelp();
  });

  // Display modes
  el.segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === ui.mode) return;
      ui.mode = mode;
      ui.selected = Object.create(null); // row keys change meaning between modes
      el.segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      render();
    });
  });

  // List: per-row copy + selection (delegated)
  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const value = btn.dataset.value;
    copyText(value).then((ok) => {
      if (ok) {
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1500);
        announce(t(btn.dataset.kind === 'ip' ? 'copiedIps' : 'copiedDomains', { count: 1 }));
      } else {
        announce(t('copyEmpty'));
      }
    });
  });

  el.list.addEventListener('change', (e) => {
    const cb = e.target.closest('.cb');
    if (!cb) return;
    if (cb.checked) ui.selected[cb.dataset.key] = cb.dataset.value;
    else delete ui.selected[cb.dataset.key];
    updateCopySelected();
  });

  // Bulk copy
  el.copyDomains.addEventListener('click', () => copyBulk(visibleByKind('host'), 'copiedDomains'));
  el.copyIps.addEventListener('click', () => copyBulk(visibleByKind('ip'), 'copiedIps'));
  el.copySelected.addEventListener('click', () => copyBulk(selectedValues(), 'copiedSelected'));

  // Settings menu
  el.settingsBtn.addEventListener('click', () => {
    if (menuOpen()) closeMenu(false); else openMenu();
  });
  el.togglePause.addEventListener('click', () => {
    setPaused(!(state && state.paused));
    closeMenu(true);
  });
  el.clearBtn.addEventListener('click', () => {
    clearTab();
    closeMenu(true);
  });
  el.settingsMenu.addEventListener('keydown', (e) => {
    const items = Array.from(el.settingsMenu.querySelectorAll('.menu-item'));
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen()) closeMenu(true);
  });
  document.addEventListener('click', (e) => {
    if (menuOpen() && !e.target.closest('.menu-wrap')) closeMenu(false);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function connectLive() {
  connection = createPanelConnection({
    chromeApi: chrome,
    onState(nextState) {
      if (!state || state.tabId !== nextState.tabId || state.siteKey !== nextState.siteKey) {
        ui.selected = Object.create(null);
      }
      state = nextState;
      render();
    },
    onConnectionChange(status) {
      ui.connectionStatus = status;
      renderHeader();
    },
    onError() {
      // Connection recovery is automatic; keep the last rendered state visible.
    }
  });
}

function init() {
  applyStaticStrings();
  wireEvents();
  if (IS_DEMO) {
    state = sampleState();
    render();
  } else {
    render(); // paint the shell immediately; STATE fills it in
    connectLive();
  }
}

init();
