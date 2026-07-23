// DomainScan — fingerprint-probe.js
// Runs in the MAIN world at document_start. It instruments the page's own
// fingerprinting-adjacent APIs to DETECT (never block) their use, preserving the
// original behavior in every case.
//
// This is a classic content script: NO import/export, self-contained, no leaked globals.
// It communicates one-way with the ISOLATED-world relay via window.postMessage.

(function () {
  'use strict';

  // Guard: if there is no window (unexpected), do nothing.
  if (typeof window === 'undefined') return;

  // Each category is reported at most once per page.
  var reported = { canvas: false, webgl: false, audio: false };

  // Emit a single signal to the relay. signal is one of 'canvas' | 'webgl' | 'audio'.
  function emit(signal) {
    if (reported[signal]) return;
    reported[signal] = true;
    try {
      window.postMessage({ source: 'domainscan-probe', signal: signal }, '*');
    } catch (e) {
      // Never let a messaging failure affect the page.
    }
  }

  // Wrap a prototype method so it signals `signal` on use, then calls through to
  // the original and returns its real result. Fully guarded so a missing API or a
  // wrapping failure never breaks the page.
  function wrap(proto, name, signal) {
    try {
      if (!proto || typeof proto[name] !== 'function') return;
      var original = proto[name];
      var patched = function () {
        try {
          emit(signal);
        } catch (e) {
          // ignore — detection must never disturb behavior
        }
        return original.apply(this, arguments);
      };
      // Preserve arity/name where possible; ignore if the property is non-configurable.
      try {
        Object.defineProperty(patched, 'name', { value: name, configurable: true });
      } catch (e) {}
      proto[name] = patched;
    } catch (e) {
      // Leave the original in place on any failure.
    }
  }

  // --- Canvas readback -----------------------------------------------------
  // signal 'canvas'
  try {
    if (typeof CanvasRenderingContext2D !== 'undefined') {
      wrap(CanvasRenderingContext2D.prototype, 'getImageData', 'canvas');
    }
  } catch (e) {}
  try {
    if (typeof HTMLCanvasElement !== 'undefined') {
      wrap(HTMLCanvasElement.prototype, 'toDataURL', 'canvas');
      wrap(HTMLCanvasElement.prototype, 'toBlob', 'canvas');
    }
  } catch (e) {}

  // --- WebGL renderer/vendor queries --------------------------------------
  // signal 'webgl' — only when the queried parameter reveals GPU identity.
  // UNMASKED_RENDERER_WEBGL = 0x9246, UNMASKED_VENDOR_WEBGL = 0x9245 (WEBGL_debug_renderer_info).
  var WEBGL_SENSITIVE_PARAMS = {};
  WEBGL_SENSITIVE_PARAMS[0x9246] = true; // UNMASKED_RENDERER_WEBGL
  WEBGL_SENSITIVE_PARAMS[0x9245] = true; // UNMASKED_VENDOR_WEBGL
  WEBGL_SENSITIVE_PARAMS[0x1F00] = true; // VENDOR
  WEBGL_SENSITIVE_PARAMS[0x1F01] = true; // RENDERER

  function wrapGetParameter(proto) {
    try {
      if (!proto || typeof proto.getParameter !== 'function') return;
      var original = proto.getParameter;
      var patched = function (pname) {
        try {
          if (WEBGL_SENSITIVE_PARAMS[pname]) emit('webgl');
        } catch (e) {}
        return original.apply(this, arguments);
      };
      try {
        Object.defineProperty(patched, 'name', { value: 'getParameter', configurable: true });
      } catch (e) {}
      proto.getParameter = patched;
    } catch (e) {}
  }

  try {
    if (typeof WebGLRenderingContext !== 'undefined') {
      wrapGetParameter(WebGLRenderingContext.prototype);
    }
  } catch (e) {}
  try {
    if (typeof WebGL2RenderingContext !== 'undefined') {
      wrapGetParameter(WebGL2RenderingContext.prototype);
    }
  } catch (e) {}

  // --- Audio fingerprinting ------------------------------------------------
  // signal 'audio' — reading frequency data is the common fingerprinting step.
  try {
    if (typeof AnalyserNode !== 'undefined') {
      wrap(AnalyserNode.prototype, 'getFloatFrequencyData', 'audio');
    }
  } catch (e) {}
  // Guard OfflineAudioContext presence per the contract; its startRendering is the
  // usual trigger for offline audio fingerprinting.
  try {
    if (typeof OfflineAudioContext !== 'undefined' &&
        OfflineAudioContext.prototype &&
        typeof OfflineAudioContext.prototype.startRendering === 'function') {
      wrap(OfflineAudioContext.prototype, 'startRendering', 'audio');
    }
  } catch (e) {}
})();
