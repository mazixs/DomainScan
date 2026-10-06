// i18n helper for DomainScan UI. Prefers chrome.i18n (driven by _locales/*/messages.json), and
// falls back to the English dictionary below so the panel still renders in demo/file:// mode.
// The keys here MUST match _locales/en/messages.json exactly.

export const FALLBACK_EN = {
  showPorts: "Show ports",
  portsHint: "Ports from request URLs. Unknown ports stay blank; these are not measured socket ports.",
  copyDomainsPorts: "Copy domains with ports",
  copyIpsPorts: "Copy IPs with ports",

  appName: 'DomainScan',
  appDesc: 'See and copy the network destinations each browser tab contacts.',
  actionTitle: 'Open DomainScan',

  recording: 'Recording',
  paused: 'Paused',
  reconnecting: 'Reconnecting…',
  settings: 'Settings',
  pauseCapture: 'Pause capture',
  resumeCapture: 'Resume capture',
  clearList: 'Clear this tab',

  activeTab: 'Active tab',
  uniqueDestinations: 'unique destinations',
  showingDestinations: 'Showing $COUNT$ destinations',
  recordingSince: 'Record kept since $TIME$',
  unencrypted: 'Contacted without encryption',
  foldedFrom: 'from',
  watchApisStop: 'Stop watching browser API use',
  watchApisStart: 'Watch browser API use',
  watchSiteStop: 'Stop watching on this site',
  watchSiteStart: 'Watch on this site',
  settingsError_apply: 'Could not apply observation settings. Try changing them again.',
  settingsError_save: 'Observation settings were applied but not saved. Change them again to save your choice.',
  settingsError_load: 'Could not load observation settings. Check and save your choice again.',
  apiWatchOff: 'Browser API use is not being watched.',
  apiWatchReload: 'Close and reopen this tab to remove earlier page API changes. Network addresses are still recorded.',
  apiWatchSiteHelp: 'This site is excluded. Embedded pages from other sites may still be observed. If the problem continues, stop watching browser API use entirely and reopen the tab.',
  viaServiceWorker: 'via service worker',
  viaServiceWorkerHint: "Requested by the site's service worker, which every tab of this site shares — not by this page.",

  fingerprintTitle: 'Possible fingerprinting',
  fingerprintTag: 'Heuristic',
  fingerprintBody:
    'Sensitive browser-environment access or several weaker signals were observed. This is API-use evidence, not proof of tracking.',
  environmentTitle: 'Browser environment accessed',
  environmentBody: 'The page read a browser-environment value. A single weak signal is not classified as fingerprinting.',
  locationTitle: 'Location access requested',
  locationBody: 'The page called the Geolocation API. The browser may still deny the request or ask for permission.',
  apiObservationTag: 'API observation',
  signalCanvasReadback: 'Canvas pixel or export data was read',
  signalWebglRenderer: 'WebGL renderer or vendor was queried',
  signalAudioReadback: 'Audio analyser data was read',
  signalTimezone: 'Local time zone or UTC offset was read',
  signalLanguage: 'Browser language settings were read',
  signalGeolocation: 'Geolocation API was called',
  signalUaHighEntropy: 'High-entropy browser/device hints were requested',

  searchPlaceholder: 'Search destinations…',
  display: 'Display',
  modeExact: 'Exact',
  modeCollapse: 'Subdomains',
  modeRegistrable: 'Domains',
  modeExactHint: 'Every hostname exactly as observed. View only, nothing deleted.',
  modeCollapseHint: 'Subdomain prefixes folded into the parent. View only, nothing deleted.',
  modeRegistrableHint: 'Grouped by registrable domain. View only, nothing deleted.',
  observedHosts: 'Observed hosts: $COUNT$',
  filters: 'Filters',
  partyFilter: 'Origin',
  featureFilter: 'Feature',
  typeFilter: 'Request type',
  filterAll: 'All',
  filterFirst: 'This site',
  filterThird: 'Third party',
  filterDirectIp: 'Direct IP',
  filterWebsocket: 'WebSocket',
  filterUnencrypted: 'HTTP or WS',
  filterWorker: 'Service worker',
  resetFilters: 'Reset filters',
  checkpointStart: 'Mark now',
  checkpointPending: 'Marking…',
  checkpointReset: 'Reset marker',
  checkpointAt: 'Since $TIME$: new and repeated requests',
  checkpointNew: 'new +$COUNT$',
  checkpointRepeat: 'again +$COUNT$',
  checkpointEmpty: 'No requests since the marker.',
  showingPartial: 'Showing $COUNT$ of $TOTAL$ destinations',
  showMore: 'Show next $COUNT$',
  storageNear: 'Session storage is $PERCENT$% full. Export this tab or clear it before the limit is reached.',
  storageFailed: 'The latest record could not be saved. Export this tab now; a service worker restart may lose recent observations.',
  exportRecord: 'Export JSON',
  exportFailed: 'Could not export the record',
  storageClear: 'Clear this tab',

  partyFirst: 'This site',
  partyThird: 'Third party',
  partyDirectIp: 'Direct IP',
  resolvedIps: 'Resolved IP addresses: $COUNT$',

  requestType_document: 'document',
  requestType_image: 'image',
  requestType_script: 'script',
  requestType_style: 'style',
  requestType_fetch: 'request',
  requestType_beacon: 'beacon',
  requestType_media: 'media',
  requestType_font: 'font',
  requestType_websocket: 'WebSocket',
  requestType_other: 'other',

  copy: 'Copy',
  copyRow: 'Copy $HOST$',
  copyDomains: 'Copy domains',
  copyIps: 'Copy IP addresses',
  copySelected: 'Copy selected',
  copySelectedCount: 'Copy selected ($COUNT$)',
  selectRow: 'Select $HOST$',
  selectAll: 'Select all shown',

  copiedDomains: '$COUNT$ domains copied',
  copiedIps: '$COUNT$ IP addresses copied',
  copiedSelected: '$COUNT$ destinations copied',
  copyEmpty: 'Nothing to copy',

  emptyTitle: 'No destinations yet',
  emptyBody: 'Destinations this tab contacts will appear here as you browse.',
  footerNote: 'New destinations appear automatically and are never removed during this tab session.'
};

function applySubs(text, substitutions) {
  if (!substitutions) return text;
  let out = text;
  for (const [name, value] of Object.entries(substitutions)) {
    out = out.replace(new RegExp('\\$' + name.toUpperCase() + '\\$', 'g'), String(value));
  }
  return out;
}

/**
 * Translate a key. `substitutions` is an object like { count: 7, host: 'a.b' } that fills
 * $COUNT$ / $HOST$ placeholders. Uses chrome.i18n when available, else the English fallback.
 */
export function t(key, substitutions) {
  if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getMessage === 'function') {
    const ordered = substitutions ? Object.values(substitutions).map(String) : undefined;
    const msg = chrome.i18n.getMessage(key, ordered);
    if (msg) return msg;
  }
  const fallback = FALLBACK_EN[key];
  if (fallback == null) return key;
  return applySubs(fallback, substitutions);
}
