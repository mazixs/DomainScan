// i18n helper for DomainScan UI. Prefers chrome.i18n (driven by _locales/*/messages.json), and
// falls back to the English dictionary below so the panel still renders in demo/file:// mode.
// The keys here MUST match _locales/en/messages.json exactly.

export const FALLBACK_EN = {
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
  modeCollapseHint: 'Subdomains shown in context of their domain. View only, nothing deleted.',
  modeRegistrableHint: 'Grouped by registrable domain. View only, nothing deleted.',

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
