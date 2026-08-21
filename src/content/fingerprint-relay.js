// DomainScan — fingerprint-relay.js
// Runs in the ISOLATED world at document_start. It accepts a private MessageChannel
// from the MAIN-world probe and forwards canonical signals to the
// background service worker.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var VALID_SIGNALS = Object.create(null);
  VALID_SIGNALS.canvas_readback = true;
  VALID_SIGNALS.webgl_renderer = true;
  VALID_SIGNALS.audio_readback = true;
  VALID_SIGNALS.timezone = true;
  VALID_SIGNALS.language = true;
  VALID_SIGNALS.geolocation = true;
  VALID_SIGNALS.ua_high_entropy = true;
  var forwarded = Object.create(null);
  var probePort = null;

  function forward(data) {
    if (VALID_SIGNALS[data.signal] !== true) return;
    if (forwarded[data.signal]) return;

    try {
      if (
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.sendMessage !== 'function'
      ) {
        return;
      }
      // Only the canonical signal name crosses this boundary. The site a signal
      // belongs to is decided by the extension from the tab's own committed URL,
      // never from a value read inside the page.
      var payload = { type: 'FINGERPRINT', signal: data.signal };
      forwarded[data.signal] = true;
      chrome.runtime.sendMessage(
        payload,
        function () {
          // Reading lastError prevents an unchecked-runtime.lastError warning.
          var ignored = chrome.runtime && chrome.runtime.lastError;
          void ignored;
        }
      );
    } catch (error) {
      // Extension reloads can invalidate this isolated context. Ignore safely.
    }
  }

  window.addEventListener('domainscan:probe-channel', function (event) {
    if (probePort || !event || !event.data || event.data.source !== 'domainscan-probe') return;
    var port = event.ports && event.ports[0];
    if (!port || typeof port.start !== 'function') return;
    probePort = port;
    probePort.onmessage = function (messageEvent) {
      var data = messageEvent && messageEvent.data;
      if (!data || typeof data !== 'object') return;
      forward(data);
    };
    probePort.start();
  }, false);
})();
