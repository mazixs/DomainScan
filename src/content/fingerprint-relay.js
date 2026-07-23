// DomainScan — fingerprint-relay.js
// Runs in the ISOLATED world at document_start. It listens for the MAIN-world probe's
// window.postMessage signals and forwards them to the background service worker.
//
// This is a classic content script: NO import/export, self-contained, no leaked globals.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var VALID_SIGNALS = { canvas: true, webgl: true, audio: true };

  window.addEventListener('message', function (e) {
    // Only trust messages posted from this same window by our probe.
    if (e.source !== window) return;
    var data = e.data;
    if (!data || data.source !== 'domainscan-probe') return;

    var signal = data.signal;
    if (!VALID_SIGNALS[signal]) return;

    // Guard against the extension context being unavailable (e.g. invalidated after
    // reload/update) and swallow any errors so the page is never affected.
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      var payload = { type: 'FINGERPRINT', signals: {} }; // MSG.FINGERPRINT (see src/common/messages.js)
      payload.signals[signal] = true;
      chrome.runtime.sendMessage(payload, function () {
        // Access lastError to prevent unchecked-runtime.lastError warnings; ignore it.
        var _ = chrome.runtime && chrome.runtime.lastError;
      });
    } catch (err) {
      // Extension context invalidated or messaging failed — nothing to do.
    }
  }, false);
})();
