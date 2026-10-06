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
  captureCheckpoint,
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

// What the extension is currently allowed to observe in pages. Sent with every STATE.
let settings = { observePageApis: true, excludedSites: [] };
const PAGE_SIZE = 200;

// UI-local state (never sent to the background).
const ui = {
  mode: 'exact',        // 'exact' | 'collapse' | 'registrable'
  query: '',
  filters: { party: 'all', feature: 'all', requestType: 'all' },
  checkpoint: null,
  checkpointPending: false,
  visibleLimit: PAGE_SIZE,
  storageUsedBytes: null,
  storageWriteFailed: false,
  settingsError: null,
  lastStorageCheck: 0,
  showPorts: readPortPreference(),
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
  toggleApis: document.getElementById('toggle-apis'),
  toggleSite: document.getElementById('toggle-site'),
  clearBtn: document.getElementById('clear-btn'),
  eyebrow: document.getElementById('eyebrow'),
  siteHost: document.getElementById('site-host'),
  siteCount: document.getElementById('site-count'),
  recordSince: document.getElementById('record-since'),
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
  showPorts: document.getElementById('show-ports'),
  showPortsLabel: document.getElementById('show-ports-label'),
  portsHelp: document.getElementById('ports-help'),
  filters: document.getElementById('filters'),
  filtersLabel: document.getElementById('filters-label'),
  partyFilterLabel: document.getElementById('party-filter-label'),
  partyFilter: document.getElementById('party-filter'),
  featureFilterLabel: document.getElementById('feature-filter-label'),
  featureFilter: document.getElementById('feature-filter'),
  typeFilterLabel: document.getElementById('type-filter-label'),
  typeFilter: document.getElementById('type-filter'),
  resetFilters: document.getElementById('reset-filters'),
  checkpointBtn: document.getElementById('checkpoint-btn'),
  checkpointStatus: document.getElementById('checkpoint-status'),
  storageNote: document.getElementById('storage-note'),
  storageMessage: document.getElementById('storage-message'),
  settingsError: document.getElementById('settings-error'),
  apiWatchHelp: document.getElementById('api-watch-help'),
  exportRecord: document.getElementById('export-record'),
  storageClear: document.getElementById('storage-clear'),
  list: document.getElementById('list'),
  showMore: document.getElementById('show-more'),
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
  // The document language drives date and time formatting, so the preview outside
  // Chrome must follow the browser locale instead of the markup default.
  const language = !IS_DEMO && chrome.i18n && chrome.i18n.getUILanguage
    ? chrome.i18n.getUILanguage()
    : navigator.language;
  // The exact tag matters: collapsing every non-Russian locale to "en" would print
  // American 12-hour timestamps to a Dutch or British reader.
  if (language) document.documentElement.lang = language;
  el.brandName.textContent = t('appName');
  el.settingsLabel.textContent = t('settings');
  el.settingsBtn.setAttribute('title', t('settings'));
  el.clearBtn.textContent = t('clearList');
  el.eyebrow.textContent = t('activeTab');
  el.searchLabel.textContent = t('searchPlaceholder');
  el.search.setAttribute('placeholder', t('searchPlaceholder'));
  el.search.setAttribute('aria-label', t('searchPlaceholder'));
  el.modeLabel.textContent = t('display');
  el.showPortsLabel.textContent = t('showPorts');
  el.portsHelp.textContent = t('portsHint');
  el.partyFilterLabel.textContent = t('partyFilter');
  el.featureFilterLabel.textContent = t('featureFilter');
  el.typeFilterLabel.textContent = t('typeFilter');
  el.resetFilters.textContent = t('resetFilters');
  el.exportRecord.textContent = t('exportRecord');
  el.storageClear.textContent = t('storageClear');
  fillOptions(el.partyFilter, [
    ['all', 'filterAll'], ['first', 'filterFirst'], ['third', 'filterThird'], ['ip', 'filterDirectIp']
  ]);
  fillOptions(el.featureFilter, [
    ['all', 'filterAll'], ['websocket', 'filterWebsocket'],
    ['unencrypted', 'filterUnencrypted'], ['worker', 'filterWorker']
  ]);
  fillOptions(el.typeFilter, [
    ['all', 'filterAll'], ...['document', 'image', 'script', 'style', 'fetch', 'beacon', 'media', 'font', 'websocket', 'other']
      .map((value) => [value, 'requestType_' + value])
  ]);
  el.segButtons.forEach((b) => {
    b.textContent = t(MODE_SEG[b.dataset.mode]);
  });
  el.copyDomains.textContent = t('copyDomains');
  el.copyIps.textContent = t('copyIps');
}

function fillOptions(select, entries) {
  for (const [value, key] of entries) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(key);
    select.appendChild(option);
  }
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
    ['host', 'pixel.metrics.test', 'third', 'beacon', 'http'],
    ['host', 'stream.media.test', 'third', 'websocket', 'wss'],
    ['ip', '203.0.113.42', 'ip', 'other', 'https']
  ];
  const destinations = Object.create(null);
  defs.forEach(([kind, value, party, requestType, transport], i) => {
    const id = kind + '|' + value;
    const port = value === 'stream.media.test' ? 8443 : transport === 'http' ? 80 : 443;
    const sources = value === 'analytics.vendor.test' ? ['page', 'worker'] : ['page'];
    destinations[id] = {
      id, kind, value, party, requestTypes: [requestType], transports: [transport],
      ports: [port],
      portDetails: { [port]: { count: 1, requestTypes: [requestType], transports: [transport], sources } },
      sources,
      ips: kind === 'host' && value === 'news.example'
        ? { '203.0.113.10': { value: '203.0.113.10', ports: [443], firstSeen: base, lastSeen: base, count: 1 } }
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
    siteStartedAt: base,
    updatedAt: base
  };
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------
function destinationCount() {
  return state && state.destinations ? Object.keys(state.destinations).length : 0;
}

function hasEvidence() {
  return destinationCount() > 0 ||
    Object.keys(state?.fingerprint?.signals || {}).length > 0;
}

/**
 * Rows for the current view (mode + search). Modes transform the VIEW only —
 * nothing in state.destinations is mutated or removed.
 * @returns {{key:string, display:string, kind:string, party:string, requestTypes:string[],
 *   transports:string[], sources:string[], foldedFrom:?string, ips:string[], grouped:number}[]}
 */
function buildRows() {
  return buildDestinationRows(state, {
    mode: ui.mode, query: ui.query, showPorts: ui.showPorts,
    filters: ui.filters, checkpoint: ui.checkpoint
  });
}

function shownRows() {
  return buildRows().slice(0, ui.visibleLimit);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  el.showPorts.checked = ui.showPorts;
  el.portsHelp.hidden = !ui.showPorts;
  el.copyDomains.textContent = t(ui.showPorts ? 'copyDomainsPorts' : 'copyDomains');
  el.copyIps.textContent = t(ui.showPorts ? 'copyIpsPorts' : 'copyIps');
  const rows = buildRows();
  const visible = rows.slice(0, ui.visibleLimit);
  renderHeader();
  renderFingerprint();
  renderModeHelp(visible.length, rows.length);
  renderFilters();
  renderCheckpoint();
  renderStorageWarning();
  renderList(visible);
  el.showMore.hidden = rows.length <= visible.length;
  if (!el.showMore.hidden) {
    el.showMore.textContent = t('showMore', { count: Math.min(PAGE_SIZE, rows.length - visible.length) });
  }
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
  renderWatchMenu(disconnected);
  el.settingsError.hidden = !ui.settingsError;
  el.settingsError.textContent = ui.settingsError ? t('settingsError_' + ui.settingsError) : '';
  const apisOff = !settings.observePageApis || settings.excludedSites.includes(state?.siteKey);
  el.apiWatchHelp.hidden = !apisOff || ['apply', 'load'].includes(ui.settingsError);
  el.apiWatchHelp.textContent = apisOff
    ? t(settings.observePageApis ? 'apiWatchSiteHelp' : 'apiWatchReload') : '';

  el.siteHost.textContent = (state && state.pageHost) || '';

  const total = destinationCount();
  el.siteCount.textContent = '';
  const strong = document.createElement('b');
  strong.textContent = String(total);
  el.siteCount.append(strong, ' ' + t('uniqueDestinations'));

  // Requests made before this moment are not part of the record, so the panel says
  // where the record starts instead of implying it covers the whole page life.
  // A tab without a site (a browser page) is not being recorded, so it says nothing.
  const startedAt = state && state.siteKey ? state.siteStartedAt : null;
  el.recordSince.textContent = Number.isFinite(startedAt)
    ? t('recordingSince', { time: formatTime(startedAt) })
    : '';
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString(document.documentElement.lang || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (_error) {
    return new Date(timestamp).toTimeString().slice(0, 5);
  }
}

// Watching page APIs can be switched off entirely, or for the site in view, because
// no in-page instrumentation is provably invisible to every bot protection.
function renderWatchMenu(disconnected) {
  const watching = settings.observePageApis;
  const siteKey = state && state.siteKey;
  const siteWatched = watching && !settings.excludedSites.includes(siteKey);

  el.toggleApis.textContent = watching ? t('watchApisStop') : t('watchApisStart');
  el.toggleApis.disabled = disconnected;
  el.toggleSite.textContent = siteWatched ? t('watchSiteStop') : t('watchSiteStart');
  el.toggleSite.disabled = disconnected || !watching || !siteKey;
}

function renderFingerprint() {
  const signals = state && state.fingerprint && state.fingerprint.signals;
  const summary = summarizeFingerprint(signals);
  const siteKey = state && state.siteKey;
  const watching = settings.observePageApis && !settings.excludedSites.includes(siteKey);

  if (!watching && summary.observed.length === 0 && !['apply', 'load'].includes(ui.settingsError)) {
    el.fpNote.hidden = false;
    el.fpTitle.textContent = t('apiWatchOff');
    el.fpTag.hidden = true;
    el.fpBody.hidden = true;
    el.signalList.textContent = '';
    return;
  }

  el.fpNote.hidden = summary.observed.length === 0;
  if (summary.observed.length === 0) return;
  el.fpTag.hidden = false;
  el.fpBody.hidden = false;

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

function renderModeHelp(shown, total) {
  el.modeHelp.textContent = '';
  el.modeHelp.append(
    t(MODE_HINT[ui.mode]) + ' ',
    hint(total > shown
      ? t('showingPartial', { count: shown, total })
      : t('showingDestinations', { count: shown }))
  );
}

function renderFilters() {
  const active = Object.values(ui.filters).filter((value) => value !== 'all').length;
  el.filtersLabel.textContent = t('filters') + (active ? ` (${active})` : '');
  el.resetFilters.disabled = active === 0;
}

function renderCheckpoint() {
  el.checkpointBtn.disabled = !state || !state.siteKey || ui.checkpointPending ||
    (!IS_DEMO && ui.connectionStatus !== 'connected');
  el.checkpointBtn.textContent = t(ui.checkpointPending ? 'checkpointPending'
    : ui.checkpoint ? 'checkpointReset' : 'checkpointStart');
  el.checkpointStatus.textContent = ui.checkpoint
    ? t('checkpointAt', { time: formatTime(ui.checkpoint.at) }) : '';
}

function renderStorageWarning() {
  const quota = !IS_DEMO && chrome.storage?.session?.QUOTA_BYTES || 10 * 1024 * 1024;
  const percent = Number.isFinite(ui.storageUsedBytes)
    ? Math.round(ui.storageUsedBytes / quota * 100) : 0;
  el.storageNote.hidden = !ui.storageWriteFailed && (percent < 80 || !hasEvidence());
  if (!el.storageNote.hidden) {
    el.storageMessage.textContent = ui.storageWriteFailed
      ? t('storageFailed') : t('storageNear', { percent });
  }
  el.exportRecord.disabled = !hasEvidence();
  el.storageClear.disabled = !hasEvidence();
}

async function refreshStorageUsage() {
  if (IS_DEMO || typeof chrome.storage?.session?.getBytesInUse !== 'function') return;
  if (Date.now() - ui.lastStorageCheck < 5000) return;
  ui.lastStorageCheck = Date.now();
  try {
    ui.storageUsedBytes = await chrome.storage.session.getBytesInUse(null);
    renderStorageWarning();
  } catch (_error) {
    // The explicit write-failure signal still warns when persistence fails.
  }
}

function hint(text) {
  const span = document.createElement('span');
  span.className = 'muted';
  span.textContent = '· ' + text;
  return span;
}

/**
 * Reconciles the list against the rows it should show. Destinations keep their own
 * element for as long as they are visible, so an expanded IP list, the focused
 * control and the scroll position survive every incoming destination.
 */
function renderList(rows) {
  if (rows.length === 0) {
    el.list.textContent = '';
    el.list.appendChild(emptyRow());
    return;
  }

  const known = new Map();
  for (const node of Array.from(el.list.children)) {
    const key = node.dataset && node.dataset.key;
    if (key) known.set(key, node);
    else node.remove(); // the empty-state placeholder
  }

  let cursor = el.list.firstChild;
  for (const row of rows) {
    let node = known.get(row.key);
    if (node) {
      known.delete(row.key);
      updateRowNode(node, row);
    } else {
      node = rowNode(row);
    }
    if (node === cursor) cursor = cursor.nextSibling;
    else el.list.insertBefore(node, cursor);
  }
  for (const node of known.values()) node.remove();
}

function emptyRow() {
  const li = document.createElement('li');
  li.className = 'empty';
  const total = destinationCount();
  if (total === 0) {
    const b = document.createElement('b');
    b.textContent = t('emptyTitle');
    li.append(b, t('emptyBody'));
  } else {
    li.textContent = ui.checkpoint && !ui.query && Object.values(ui.filters).every((value) => value === 'all')
      ? t('checkpointEmpty') : t('showingDestinations', { count: 0 });
  }
  return li;
}

let rowIdSequence = 0;

function rowNode(row) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.key = row.key;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'cb';
  cb.id = 'cb-' + (++rowIdSequence);
  li.appendChild(cb);

  const main = document.createElement('div');
  main.className = 'row-main';

  const host = document.createElement('label');
  host.className = 'host';
  host.setAttribute('for', cb.id);
  main.appendChild(host);

  const sub = document.createElement('p');
  sub.className = 'sub';
  main.appendChild(sub);

  li.appendChild(main);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-btn';
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = t('copy');
  const done = document.createElement('span');
  done.className = 'done';
  done.setAttribute('aria-hidden', 'true');
  done.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M20 6L9 17l-5-5"/></svg>';
  copy.append(txt, done);
  li.appendChild(copy);

  updateRowNode(li, row);
  return li;
}

// Each part is rewritten only when its own content changed, so repainting a row
// costs nothing when a destination is merely seen again.
function updateRowNode(li, row) {
  const isIp = row.kind === 'ip';
  li.classList.toggle('third', row.party === 'third');

  const cb = li.querySelector('.cb');
  cb.checked = ui.selected[row.key] != null;
  cb.dataset.key = row.key;
  cb.dataset.value = row.display;
  cb.setAttribute('aria-label', t('selectRow', { host: row.display }));

  const hostSignature = ui.mode + '|' + row.display;
  if (li.dataset.host !== hostSignature) {
    li.dataset.host = hostSignature;
    const host = li.querySelector('.host');
    host.className = 'host' + (isIp ? ' ip' : ui.mode === 'exact' ? ' exact' : '');
    host.textContent = '';
    appendHostMarkup(host, row.display, isIp);
  }

  const subSignature = [
    row.party,
    row.requestTypes.join(','),
    row.transports.join(','),
    row.sources.join(','),
    row.foldedFrom || '',
    row.grouped,
    row.changeStatus || '',
    row.changeCount
  ].join('|');
  if (li.dataset.sub !== subSignature) {
    li.dataset.sub = subSignature;
    const sub = li.querySelector('.sub');
    sub.textContent = '';

    const party = document.createElement('span');
    party.className = 'party party-' + row.party;
    const mk = document.createElement('span');
    mk.className = 'mk';
    mk.setAttribute('aria-hidden', 'true');
    party.append(mk, t(PARTY_KEY[row.party]));
    sub.appendChild(party);

    sub.appendChild(sep());

    const rtype = document.createElement('span');
    rtype.className = 'rtype';
    rtype.textContent = row.requestTypes.map((type) => t('requestType_' + type)).join(', ');
    sub.appendChild(rtype);

    // A folded label names the host it stands for, so nothing observed is hidden.
    if (row.foldedFrom) {
      sub.appendChild(sep());
      const origin = document.createElement('span');
      origin.className = 'from';
      const host = document.createElement('code');
      host.textContent = row.foldedFrom;
      origin.append(t('foldedFrom') + ' ', host);
      sub.appendChild(origin);
    }

    // Plain http or ws is a fact about the request, stated as the scheme itself
    // rather than as a warning: the explanation lives in the title.
    const insecure = row.transports.filter((transport) => transport === 'http' || transport === 'ws');
    if (insecure.length > 0) {
      sub.appendChild(sep());
      const mark = document.createElement('span');
      mark.className = 'insecure';
      mark.textContent = insecure.join(', ');
      mark.setAttribute('title', t('unencrypted'));
      sub.appendChild(mark);
    }

    // Traffic a site's service worker makes belongs to the site but not to this
    // page, and the worker is shared by every tab of that site.
    if (row.sources.includes('worker')) {
      sub.appendChild(sep());
      const worker = document.createElement('span');
      worker.className = 'via-worker';
      worker.textContent = t('viaServiceWorker');
      worker.setAttribute('title', t('viaServiceWorkerHint'));
      sub.appendChild(worker);
    }

    if (row.grouped > 1) {
      sub.appendChild(sep());
      const g = document.createElement('span');
      g.className = 'grouped';
      // count only — no invented string; the shown-count already explains grouping
      g.textContent = '\u00d7' + row.grouped;
      sub.appendChild(g);
    }
    if (row.changeStatus) {
      sub.appendChild(sep());
      const mark = document.createElement('span');
      mark.className = 'change-mark';
      mark.textContent = t(row.changeStatus === 'new' ? 'checkpointNew' : 'checkpointRepeat', {
        count: row.changeCount
      });
      sub.appendChild(mark);
    }
  }

  updateRowMembers(li, row);
  updateRowAddresses(li, isIp ? [] : row.ips);

  const copy = li.querySelector('.copy-btn');
  copy.dataset.value = row.display;
  copy.dataset.kind = row.kind;
  copy.setAttribute('aria-label', t('copyRow', { host: row.display }));
}

function updateRowMembers(li, row) {
  const members = row.members || [];
  const needed = ui.mode === 'registrable' && row.kind === 'host' &&
    (members.length > 1 || members[0]?.value !== row.display);
  let details = li.querySelector('.members-details');
  if (!needed) {
    if (details) details.remove();
    return;
  }
  if (!details) {
    details = document.createElement('details');
    details.className = 'members-details';
    details.append(document.createElement('summary'), document.createElement('ul'));
    details.querySelector('ul').className = 'members-list';
    li.querySelector('.row-main').appendChild(details);
  }
  details.querySelector('summary').textContent = t('observedHosts', { count: members.length });
  const signature = members.map((member) => [member.value, member.change?.status, member.change?.count].join('|')).join(';');
  if (details.dataset.members === signature) return;
  details.dataset.members = signature;
  const list = details.querySelector('ul');
  const known = new Map(Array.from(list.children).map((item) => [item.dataset.value, item]));
  let cursor = list.firstChild;
  for (const member of members) {
    let item = known.get(member.value);
    if (item) {
      known.delete(member.value);
    } else {
      item = document.createElement('li');
      item.dataset.value = member.value;
      const address = document.createElement('code');
      address.textContent = member.value;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'member-copy';
      copy.dataset.value = member.value;
      copy.dataset.kind = 'host';
      copy.textContent = t('copy');
      copy.setAttribute('aria-label', t('copyRow', { host: member.value }));
      item.append(address, copy);
    }
    let change = item.querySelector('.change-mark');
    if (member.change) {
      if (!change) {
        change = document.createElement('span');
        change.className = 'change-mark';
        item.insertBefore(change, item.querySelector('button'));
      }
      change.textContent = t(member.change.status === 'new' ? 'checkpointNew' : 'checkpointRepeat', {
        count: member.change.count
      });
    } else if (change) {
      change.remove();
    }
    if (item === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(item, cursor);
  }
  for (const item of known.values()) item.remove();
}

function updateRowAddresses(li, addresses) {
  const signature = addresses.join(',');
  if (li.dataset.ips === signature) return;
  li.dataset.ips = signature;

  let details = li.querySelector('.ip-details');
  if (addresses.length === 0) {
    if (details) details.remove();
    return;
  }
  if (!details) {
    details = document.createElement('details');
    details.className = 'ip-details';
    details.appendChild(document.createElement('summary'));
    const list = document.createElement('ul');
    list.className = 'ip-addresses';
    details.appendChild(list);
    li.querySelector('.row-main').appendChild(details);
  }

  details.querySelector('summary').textContent = t('resolvedIps', { count: addresses.length });
  const list = details.querySelector('.ip-addresses');
  list.textContent = '';
  for (const address of addresses) {
    const item = document.createElement('li');
    item.textContent = address;
    list.appendChild(item);
  }
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
  const rows = shownRows();
  return kind === 'ip' ? collectVisibleIps(rows) : collectVisibleDomains(rows);
}

function exportRecord() {
  if (!state || !hasEvidence()) return;
  try {
    const content = JSON.stringify({
      format: 'domainscan-record', version: 1,
      exportedAt: new Date().toISOString(),
      storageWriteFailed: ui.storageWriteFailed,
      record: state
    }, null, 2);
    const blobUrl = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    const host = (state.pageHost || 'tab').replace(/[^a-z0-9.-]/gi, '_');
    link.href = blobUrl;
    link.download = `domainscan-${host}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  } catch (_error) {
    announce(t('exportFailed'));
  }
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

function setObservePageApis(enabled) {
  if (IS_DEMO) {
    settings = { ...settings, observePageApis: enabled };
    render();
  } else if (connection) {
    connection.post({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled });
  }
}

function setSiteObserved(observed) {
  const siteKey = state && state.siteKey;
  if (!siteKey) return;
  if (IS_DEMO) {
    const excludedSites = observed
      ? settings.excludedSites.filter((site) => site !== siteKey)
      : [...settings.excludedSites, siteKey];
    settings = { ...settings, excludedSites };
    render();
  } else if (connection) {
    connection.post({ type: MSG.SET_SITE_OBSERVED, observed });
  }
}

function clearTab() {
  ui.selected = Object.create(null);
  ui.checkpoint = null;
  ui.visibleLimit = PAGE_SIZE;
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
function readPortPreference() {
  try { return localStorage.getItem('domainscan.showPorts') === 'true'; }
  catch (_error) { return false; }
}

function wireEvents() {
  el.showPorts.addEventListener('change', () => {
    ui.showPorts = el.showPorts.checked;
    ui.selected = Object.create(null);
    ui.visibleLimit = PAGE_SIZE;
    try { localStorage.setItem('domainscan.showPorts', String(ui.showPorts)); }
    catch (_error) { /* The current view still works when storage is unavailable. */ }
    render();
  });
  // Search
  el.search.addEventListener('input', () => {
    ui.query = el.search.value;
    ui.selected = Object.create(null);
    ui.visibleLimit = PAGE_SIZE;
    render();
  });

  for (const [element, key] of [
    [el.partyFilter, 'party'], [el.featureFilter, 'feature'], [el.typeFilter, 'requestType']
  ]) {
    element.addEventListener('change', () => {
      ui.filters[key] = element.value;
      ui.selected = Object.create(null);
      ui.visibleLimit = PAGE_SIZE;
      render();
    });
  }
  el.resetFilters.addEventListener('click', () => {
    ui.filters = { party: 'all', feature: 'all', requestType: 'all' };
    el.partyFilter.value = 'all';
    el.featureFilter.value = 'all';
    el.typeFilter.value = 'all';
    el.filters.open = false;
    ui.selected = Object.create(null);
    ui.visibleLimit = PAGE_SIZE;
    render();
  });
  el.checkpointBtn.addEventListener('click', () => {
    if (ui.checkpoint) {
      ui.checkpoint = null;
      ui.selected = Object.create(null);
      ui.visibleLimit = PAGE_SIZE;
      render();
    } else if (IS_DEMO) {
      ui.checkpoint = captureCheckpoint(state);
      ui.selected = Object.create(null);
      ui.visibleLimit = PAGE_SIZE;
      render();
    } else if (connection?.post({ type: MSG.CHECKPOINT_REQUEST })) {
      ui.checkpointPending = true;
      renderCheckpoint();
    }
  });
  el.showMore.addEventListener('click', () => {
    const firstNew = ui.visibleLimit;
    ui.visibleLimit += PAGE_SIZE;
    render();
    if (el.showMore.hidden) el.list.children[firstNew]?.querySelector('.cb')?.focus();
  });
  el.exportRecord.addEventListener('click', exportRecord);
  el.storageClear.addEventListener('click', clearTab);

  // Display modes
  el.segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === ui.mode) return;
      ui.mode = mode;
      ui.selected = Object.create(null); // row keys change meaning between modes
      ui.visibleLimit = PAGE_SIZE;
      el.segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      render();
    });
  });

  // List: per-row copy + selection (delegated)
  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn, .member-copy');
    if (!btn) return;
    const value = btn.dataset.value;
    copyText(value).then((ok) => {
      if (ok) {
        if (btn.classList.contains('copy-btn')) {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        }
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
  el.toggleApis.addEventListener('click', () => {
    setObservePageApis(!settings.observePageApis);
    closeMenu(true);
  });
  el.toggleSite.addEventListener('click', () => {
    const siteKey = state && state.siteKey;
    setSiteObserved(settings.excludedSites.includes(siteKey));
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
    onState(nextState, nextSettings, storageWriteFailed, settingsError) {
      if (!state || state.tabId !== nextState.tabId || state.siteKey !== nextState.siteKey ||
          state.siteStartedAt !== nextState.siteStartedAt ||
          state.recordGeneration !== nextState.recordGeneration) {
        ui.selected = Object.create(null);
        ui.checkpoint = null;
        ui.checkpointPending = false;
        ui.visibleLimit = PAGE_SIZE;
      }
      state = nextState;
      ui.storageWriteFailed = storageWriteFailed;
      ui.settingsError = ['apply', 'save', 'load'].includes(settingsError) ? settingsError : null;
      if (nextSettings) {
        settings = {
          observePageApis: nextSettings.observePageApis !== false,
          excludedSites: Array.isArray(nextSettings.excludedSites) ? nextSettings.excludedSites : []
        };
      }
      render();
      refreshStorageUsage();
    },
    onCheckpoint(checkpointState, at) {
      ui.checkpointPending = false;
      if (!state || !checkpointState || state.tabId !== checkpointState.tabId ||
          state.siteKey !== checkpointState.siteKey ||
          state.siteStartedAt !== checkpointState.siteStartedAt ||
          state.recordGeneration !== checkpointState.recordGeneration) {
        renderCheckpoint();
        return;
      }
      ui.checkpoint = captureCheckpoint(checkpointState, at);
      if ((state.updatedAt || 0) <= (checkpointState.updatedAt || 0)) state = checkpointState;
      ui.selected = Object.create(null);
      ui.visibleLimit = PAGE_SIZE;
      render();
    },
    onConnectionChange(status) {
      ui.connectionStatus = status;
      if (status !== 'connected') ui.checkpointPending = false;
      renderHeader();
      renderCheckpoint();
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
