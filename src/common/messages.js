// Shared message + storage constants for DomainScan.
// Used by the service worker and the side panel. Do not change these values without
// updating docs/ARCHITECTURE.md and every consumer.

export const PORT_NAME = 'domainscan';

export const MSG = {
  HELLO: 'HELLO',            // panel -> bg  { type, tabId }
  STATE: 'STATE',            // bg -> panel  { type, state: TabState, settings: Settings }
  SET_PAUSED: 'SET_PAUSED',  // panel -> bg  { type, paused: boolean }
  CLEAR: 'CLEAR',            // panel -> bg  { type }
  // panel -> bg  { type, enabled: boolean } — page API observation as a whole
  SET_OBSERVE_PAGE_APIS: 'SET_OBSERVE_PAGE_APIS',
  // panel -> bg  { type, observed: boolean } — the site of the bound tab only
  SET_SITE_OBSERVED: 'SET_SITE_OBSERVED',
  FINGERPRINT: 'FINGERPRINT' // content -> bg { type, signal: canonicalSignalName }
};

export const SETTINGS_KEY = 'settings';

export const PROBE_SCRIPT_ID = 'domainscan-page-probe';

export const STORAGE_PREFIX = 'tab:';

/** Storage key for a tab's accumulated state. */
export function tabKey(tabId) {
  return STORAGE_PREFIX + tabId;
}
