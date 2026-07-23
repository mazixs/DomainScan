// i18n helper for DomainScan UI. Prefers chrome.i18n (driven by _locales/*/messages.json), and
// falls back to the English dictionary below so the panel still renders in demo/file:// mode.
// The keys here MUST match _locales/en/messages.json exactly.

export const FALLBACK_EN = {
  appName: 'DomainScan',
  appDesc: 'See and copy the network destinations each browser tab contacts.',
  actionTitle: 'Open DomainScan',

  recording: 'Recording',
  paused: 'Paused',
  settings: 'Settings',
  pauseCapture: 'Pause capture',
  resumeCapture: 'Resume capture',
  clearList: 'Clear this tab',

  activeTab: 'Active tab',
  uniqueDestinations: 'unique destinations',
  showingDestinations: 'Showing $COUNT$ destinations',

  fingerprintTitle: 'Possible fingerprinting',
  fingerprintTag: 'Heuristic',
  fingerprintBody:
    'Canvas readback and WebGL renderer queries were observed on this page. This is a signal to be aware of, not proof of tracking.',

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
