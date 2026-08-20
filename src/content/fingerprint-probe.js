// DomainScan — fingerprint-probe.js
// Runs in the page's MAIN world at document_start. It observes selected
// fingerprinting/environment API reads without blocking them or sending network
// requests. Signals are forwarded one-way over a private MessageChannel.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var reported = Object.create(null);
  var channel;
  try {
    channel = new MessageChannel();
    window.dispatchEvent(new MessageEvent('domainscan:probe-channel', {
      data: { source: 'domainscan-probe' },
      ports: [channel.port2]
    }));
  } catch (error) {
    return;
  }

  function emit(signal) {
    if (reported[signal]) return;
    reported[signal] = true;
    try {
      channel.port1.postMessage({ signal: signal });
    } catch (error) {
      // Observation must never affect the page.
    }
  }

  // A wrapper that reveals itself is worse than no observation at all: bot
  // protections read native sources and treat a patched built-in as a tampered
  // browser, which turns a solvable check into a hard block. Every wrapper
  // therefore reports the source of the function it replaced, and the mechanism
  // that does so reports itself as untouched.
  var replacedSources = typeof WeakMap === 'function' ? new WeakMap() : null;
  var nativeToString = Function.prototype.toString;

  function conceal(wrapper, original) {
    if (!replacedSources) return;
    try {
      replacedSources.set(wrapper, original);
    } catch (error) {}
  }

  function concealedSourceTarget(receiver) {
    if (!replacedSources) return receiver;
    try {
      var original = replacedSources.get(receiver);
      return original || receiver;
    } catch (error) {
      return receiver;
    }
  }

  // Frames of this content script must not appear in errors a page can read:
  // they expose the extension ID and mark the browser as instrumented.
  var selfSource = (function () {
    try {
      var frames = new Error().stack || '';
      var match = frames.match(/(chrome-extension:\/\/[^\s):]+)/);
      return match ? match[1] : 'fingerprint-probe.js';
    } catch (error) {
      return 'fingerprint-probe.js';
    }
  })();

  function withoutProbeFrames(error) {
    try {
      if (!error || typeof error.stack !== 'string') return error;
      if (error.stack.indexOf(selfSource) === -1) return error;
      error.stack = error.stack
        .split('\n')
        .filter(function (line) {
          return line.indexOf(selfSource) === -1;
        })
        .join('\n');
    } catch (ignored) {
      // A read-only stack stays as it is; the original error is still rethrown.
    }
    return error;
  }

  function namedWrapper(name, length, invoke) {
    // A concise method has no own "prototype" property and cannot be
    // constructed, which is exactly how a native built-in behaves.
    var holder = {
      wrapper() {
        try {
          return invoke(this, arguments);
        } catch (error) {
          throw withoutProbeFrames(error);
        }
      }
    };
    var wrapper = holder.wrapper;
    try {
      Object.defineProperty(wrapper, 'name', {
        value: name,
        configurable: true
      });
    } catch (error) {}
    try {
      Object.defineProperty(wrapper, 'length', {
        value: length,
        configurable: true
      });
    } catch (error) {}
    return wrapper;
  }

  function replaceMethod(proto, name, createInvoke) {
    try {
      if (!proto) return;
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      var original = descriptor.value;
      var patched = namedWrapper(name, original.length, createInvoke(original));
      conceal(patched, original);
      Object.defineProperty(proto, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: patched
      });
    } catch (error) {
      // Non-configurable or unusual host objects remain untouched.
    }
  }

  function observeMethod(proto, name, signal) {
    replaceMethod(proto, name, function (original) {
      return function (receiver, args) {
        var result = original.apply(receiver, args);
        try {
          emit(signal);
        } catch (error) {}
        return result;
      };
    });
  }

  function observeGetter(proto, name, signal) {
    try {
      if (!proto) return;
      var descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.get !== 'function') return;
      var originalGet = descriptor.get;
      var patchedGet = namedWrapper('get ' + name, originalGet.length, function (receiver) {
        var result = originalGet.call(receiver);
        try {
          emit(signal);
        } catch (error) {}
        return result;
      });
      conceal(patchedGet, originalGet);
      Object.defineProperty(proto, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: patchedGet,
        set: descriptor.set
      });
    } catch (error) {
      // Non-configurable or unusual host objects remain untouched.
    }
  }

  // Installed before the first wrapper so no page script can capture the
  // original Function.prototype.toString in between.
  (function installSourceConcealment() {
    try {
      if (!replacedSources) return;
      var descriptor = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
      if (!descriptor || typeof descriptor.value !== 'function') return;
      var original = descriptor.value;
      var patched = namedWrapper('toString', original.length, function (receiver) {
        return nativeToString.call(concealedSourceTarget(receiver));
      });
      conceal(patched, original);
      Object.defineProperty(Function.prototype, 'toString', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: patched
      });
    } catch (error) {
      // Leaving toString untouched is safer than a half-installed wrapper.
    }
  })();

  // Canvas pixel readback. Drawing alone is intentionally not observed.
  try {
    if (typeof CanvasRenderingContext2D !== 'undefined') {
      observeMethod(
        CanvasRenderingContext2D.prototype,
        'getImageData',
        'canvas_readback'
      );
    }
  } catch (error) {}
  try {
    if (typeof HTMLCanvasElement !== 'undefined') {
      observeMethod(HTMLCanvasElement.prototype, 'toDataURL', 'canvas_readback');
      observeMethod(HTMLCanvasElement.prototype, 'toBlob', 'canvas_readback');
    }
  } catch (error) {}

  // Only parameters that reveal the renderer/vendor identity are observed.
  var WEBGL_SENSITIVE_PARAMS = Object.create(null);
  WEBGL_SENSITIVE_PARAMS[0x9245] = true; // UNMASKED_VENDOR_WEBGL
  WEBGL_SENSITIVE_PARAMS[0x9246] = true; // UNMASKED_RENDERER_WEBGL
  WEBGL_SENSITIVE_PARAMS[0x1F00] = true; // VENDOR
  WEBGL_SENSITIVE_PARAMS[0x1F01] = true; // RENDERER

  function observeWebGlGetParameter(proto) {
    replaceMethod(proto, 'getParameter', function (original) {
      return function (receiver, args) {
        var result = original.apply(receiver, args);
        try {
          if (WEBGL_SENSITIVE_PARAMS[args[0]] === true) {
            emit('webgl_renderer');
          }
        } catch (error) {}
        return result;
      };
    });
  }

  try {
    if (typeof WebGLRenderingContext !== 'undefined') {
      observeWebGlGetParameter(WebGLRenderingContext.prototype);
    }
  } catch (error) {}
  try {
    if (typeof WebGL2RenderingContext !== 'undefined') {
      observeWebGlGetParameter(WebGL2RenderingContext.prototype);
    }
  } catch (error) {}

  // Audio data readback. Constructing or rendering audio alone is intentionally
  // not classified; the page must read analyser data.
  try {
    if (typeof AnalyserNode !== 'undefined') {
      observeMethod(
        AnalyserNode.prototype,
        'getFloatFrequencyData',
        'audio_readback'
      );
      observeMethod(
        AnalyserNode.prototype,
        'getByteFrequencyData',
        'audio_readback'
      );
    }
  } catch (error) {}
  // Local timezone reads. No value is collected; only the access is reported.
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      observeMethod(
        Intl.DateTimeFormat.prototype,
        'resolvedOptions',
        'timezone'
      );
    }
  } catch (error) {}
  try {
    if (typeof Date !== 'undefined') {
      observeMethod(Date.prototype, 'getTimezoneOffset', 'timezone');
    }
  } catch (error) {}

  // Browser language reads.
  try {
    if (typeof Navigator !== 'undefined') {
      observeGetter(Navigator.prototype, 'language', 'language');
      observeGetter(Navigator.prototype, 'languages', 'language');
    }
  } catch (error) {}

  // Explicit access to the browser geolocation API.
  try {
    if (typeof Geolocation !== 'undefined') {
      observeMethod(
        Geolocation.prototype,
        'getCurrentPosition',
        'geolocation'
      );
      observeMethod(Geolocation.prototype, 'watchPosition', 'geolocation');
    }
  } catch (error) {}

  // High-entropy User-Agent Client Hints.
  try {
    if (typeof NavigatorUAData !== 'undefined') {
      observeMethod(
        NavigatorUAData.prototype,
        'getHighEntropyValues',
        'ua_high_entropy'
      );
    }
  } catch (error) {}
})();
