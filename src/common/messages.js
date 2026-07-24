// Shared message + storage constants for DomainScan.
// Used by the service worker and the side panel. Do not change these values without
// updating docs/ARCHITECTURE.md and every consumer.

export const PORT_NAME = 'domainscan';

export const MSG = {
  HELLO: 'HELLO',            // panel -> bg  { type, tabId }
  STATE: 'STATE',            // bg -> panel  { type, state: TabState }
  SET_PAUSED: 'SET_PAUSED',  // panel -> bg  { type, paused: boolean }
  CLEAR: 'CLEAR',            // panel -> bg  { type }
  FINGERPRINT: 'FINGERPRINT' // content -> bg { type, signal: canonicalSignalName }
};

export const STORAGE_PREFIX = 'tab:';

/** Storage key for a tab's accumulated state. */
export function tabKey(tabId) {
  return STORAGE_PREFIX + tabId;
}
