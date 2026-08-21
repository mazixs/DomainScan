import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const probeSource = await readFile(
  new URL('../src/content/fingerprint-probe.js', import.meta.url),
  'utf8'
);
const relaySource = await readFile(
  new URL('../src/content/fingerprint-relay.js', import.meta.url),
  'utf8'
);

const SIGNALS = [
  'canvas_readback',
  'webgl_renderer',
  'audio_readback',
  'timezone',
  'language',
  'geolocation',
  'ua_high_entropy'
];

function method(returnValue) {
  return function () {
    return {
      returnValue,
      receiver: this,
      arguments: Array.from(arguments)
    };
  };
}

function createProbeHarness({ install = true } = {}) {
  function CanvasRenderingContext2D() {}
  function HTMLCanvasElement() {}
  function WebGLRenderingContext() {}
  function WebGL2RenderingContext() {}
  function AnalyserNode() {}
  function OfflineAudioContext() {}
  function DateHarness() {}
  function DateTimeFormat() {}
  function Navigator() {}
  function Geolocation() {}
  function NavigatorUAData() {}

  Object.defineProperty(CanvasRenderingContext2D.prototype, 'getImageData', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function getImageData(x, y, width, height) {
      return {
        returnValue: 'image-data',
        receiver: this,
        arguments: [x, y, width, height]
      };
    }
  });
  HTMLCanvasElement.prototype.toDataURL = method('data-url');
  HTMLCanvasElement.prototype.toBlob = method('blob');
  WebGLRenderingContext.prototype.getParameter = method('webgl-1');
  WebGL2RenderingContext.prototype.getParameter = method('webgl-2');
  AnalyserNode.prototype.getFloatFrequencyData = method('frequency-data');
  AnalyserNode.prototype.getByteFrequencyData = method('byte-frequency-data');
  OfflineAudioContext.prototype.startRendering = method('rendering');
  DateHarness.prototype.getTimezoneOffset = method('timezone-offset');
  DateTimeFormat.prototype.resolvedOptions = method('resolved-options');
  Geolocation.prototype.getCurrentPosition = method('position');
  Geolocation.prototype.watchPosition = method('watch');
  NavigatorUAData.prototype.getHighEntropyValues = method('entropy');

  Object.defineProperty(Navigator.prototype, 'language', {
    configurable: true,
    enumerable: true,
    get() {
      return this._language;
    }
  });
  Object.defineProperty(Navigator.prototype, 'languages', {
    configurable: true,
    enumerable: false,
    get() {
      return this._languages;
    }
  });

  DateTimeFormat.prototype.marker = 'date-time-format';
  const IntlHarness = {
    DateTimeFormat: function () {
      return new DateTimeFormat();
    }
  };
  IntlHarness.DateTimeFormat.prototype = DateTimeFormat.prototype;

  const posted = [];
  class MessageChannel {
    constructor() {
      this.port1 = {
        postMessage(data) {
          posted.push({ data });
        }
      };
      this.port2 = {};
    }
  }
  class MessageEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const window = {
    dispatchEvent() {}
  };
  const network = {
    fetchCalls: 0,
    xhrCalls: 0
  };

  function XMLHttpRequest() {
    network.xhrCalls += 1;
    throw new Error('network access is forbidden');
  }

  const context = vm.createContext({
    window,
    CanvasRenderingContext2D,
    HTMLCanvasElement,
    WebGLRenderingContext,
    WebGL2RenderingContext,
    AnalyserNode,
    OfflineAudioContext,
    Date: DateHarness,
    Intl: IntlHarness,
    Navigator,
    Geolocation,
    NavigatorUAData,
    MessageChannel,
    MessageEvent,
    fetch() {
      network.fetchCalls += 1;
      throw new Error('network access is forbidden');
    },
    XMLHttpRequest
  });

  if (install) {
    vm.runInContext(probeSource, context, { filename: 'fingerprint-probe.js' });
  }

  return {
    // Evaluates page-side code inside the probe's own realm, so it sees the same
    // Function.prototype a real page script would see.
    evaluate: (code) => vm.runInContext(code, context),
    constructors: {
      CanvasRenderingContext2D,
      HTMLCanvasElement,
      WebGLRenderingContext,
      WebGL2RenderingContext,
      AnalyserNode,
      OfflineAudioContext,
      DateHarness,
      DateTimeFormat,
      Navigator,
      Geolocation,
      NavigatorUAData
    },
    posted,
    network
  };
}

function postedSignals(harness) {
  return harness.posted.map(({ data }) => data.signal);
}

test('probe reports canvas readback once and preserves method behavior', () => {
  const harness = createProbeHarness();
  const { CanvasRenderingContext2D, HTMLCanvasElement } = harness.constructors;
  const context = new CanvasRenderingContext2D();
  const canvas = new HTMLCanvasElement();

  const imageResult = context.getImageData(1, 2, 3, 4);
  const urlResult = canvas.toDataURL('image/png');
  canvas.toBlob(() => {});

  assert.equal(imageResult.returnValue, 'image-data');
  assert.equal(imageResult.receiver, context);
  assert.deepEqual(imageResult.arguments, [1, 2, 3, 4]);
  assert.equal(urlResult.returnValue, 'data-url');
  const descriptor = Object.getOwnPropertyDescriptor(
    CanvasRenderingContext2D.prototype,
    'getImageData'
  );
  assert.equal(descriptor.configurable, true);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, true);
  assert.equal(descriptor.value.name, 'getImageData');
  assert.equal(descriptor.value.length, 4);
  assert.deepEqual(postedSignals(harness), ['canvas_readback']);
});

test('probe reports only sensitive WebGL renderer and vendor parameters', () => {
  const harness = createProbeHarness();
  const { WebGLRenderingContext, WebGL2RenderingContext } = harness.constructors;
  const webgl = new WebGLRenderingContext();
  const webgl2 = new WebGL2RenderingContext();

  const ordinary = webgl.getParameter(0x0D33);
  const renderer = webgl.getParameter(0x9246);
  webgl.getParameter(0x1F00);
  webgl2.getParameter(0x9245);

  assert.equal(ordinary.returnValue, 'webgl-1');
  assert.equal(renderer.receiver, webgl);
  assert.deepEqual(renderer.arguments, [0x9246]);
  assert.deepEqual(postedSignals(harness), ['webgl_renderer']);
});

test('probe reports audio readback once and preserves both audio APIs', () => {
  const harness = createProbeHarness();
  const { AnalyserNode, OfflineAudioContext } = harness.constructors;
  const analyser = new AnalyserNode();
  const offline = new OfflineAudioContext();

  const frequency = analyser.getFloatFrequencyData('buffer');
  const rendering = offline.startRendering();

  assert.equal(frequency.returnValue, 'frequency-data');
  assert.equal(rendering.returnValue, 'rendering');
  assert.deepEqual(postedSignals(harness), ['audio_readback']);
});

test('starting offline audio rendering alone is not classified as audio readback', () => {
  const harness = createProbeHarness();
  const { OfflineAudioContext } = harness.constructors;

  const rendering = new OfflineAudioContext().startRendering();

  assert.equal(rendering.returnValue, 'rendering');
  assert.deepEqual(postedSignals(harness), []);
});

test('probe treats byte analyser frequency data as audio readback', () => {
  const harness = createProbeHarness();
  const { AnalyserNode } = harness.constructors;

  const result = new AnalyserNode().getByteFrequencyData('buffer');

  assert.equal(result.returnValue, 'byte-frequency-data');
  assert.deepEqual(postedSignals(harness), ['audio_readback']);
});

test('probe reports timezone reads through Intl and Date without changing results', () => {
  const harness = createProbeHarness();
  const { DateHarness, DateTimeFormat } = harness.constructors;
  const date = new DateHarness();
  const formatter = new DateTimeFormat();

  const options = formatter.resolvedOptions('ignored');
  const offset = date.getTimezoneOffset();

  assert.equal(options.returnValue, 'resolved-options');
  assert.equal(options.receiver, formatter);
  assert.deepEqual(options.arguments, ['ignored']);
  assert.equal(offset.returnValue, 'timezone-offset');
  assert.deepEqual(postedSignals(harness), ['timezone']);
});

test('probe reports navigator language getters and preserves their descriptors', () => {
  const harness = createProbeHarness();
  const { Navigator } = harness.constructors;
  const navigator = new Navigator();
  navigator._language = 'ru-RU';
  navigator._languages = ['ru-RU', 'en'];

  assert.equal(navigator.language, 'ru-RU');
  assert.deepEqual(navigator.languages, ['ru-RU', 'en']);

  const languageDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    'language'
  );
  const languagesDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    'languages'
  );
  assert.equal(languageDescriptor.configurable, true);
  assert.equal(languageDescriptor.enumerable, true);
  assert.equal(languagesDescriptor.configurable, true);
  assert.equal(languagesDescriptor.enumerable, false);
  assert.deepEqual(postedSignals(harness), ['language']);
});

test('probe reports geolocation requests without blocking callbacks or return values', () => {
  const harness = createProbeHarness();
  const { Geolocation } = harness.constructors;
  const geolocation = new Geolocation();
  const success = () => {};
  const options = { enableHighAccuracy: true };

  const position = geolocation.getCurrentPosition(success, undefined, options);
  const watch = geolocation.watchPosition(success);

  assert.equal(position.returnValue, 'position');
  assert.equal(position.receiver, geolocation);
  assert.deepEqual(position.arguments, [success, undefined, options]);
  assert.equal(watch.returnValue, 'watch');
  assert.deepEqual(postedSignals(harness), ['geolocation']);
});

test('probe reports high-entropy UA hint reads and preserves the Promise-like result', () => {
  const harness = createProbeHarness();
  const { NavigatorUAData } = harness.constructors;
  const uaData = new NavigatorUAData();
  const hints = ['architecture', 'platformVersion'];

  const result = uaData.getHighEntropyValues(hints);

  assert.equal(result.returnValue, 'entropy');
  assert.equal(result.receiver, uaData);
  assert.deepEqual(result.arguments, [hints]);
  assert.deepEqual(postedSignals(harness), ['ua_high_entropy']);
});

test('probe performs no external requests while installing or observing signals', () => {
  const harness = createProbeHarness();
  const { DateHarness, Navigator } = harness.constructors;

  new DateHarness().getTimezoneOffset();
  const navigator = new Navigator();
  navigator._language = 'en';
  void navigator.language;

  assert.deepEqual(harness.network, { fetchCalls: 0, xhrCalls: 0 });
});

function createRelayHarness() {
  let channelListener;
  const sent = [];
  const window = {
    addEventListener(type, listener) {
      assert.equal(type, 'domainscan:probe-channel');
      channelListener = listener;
    },
    // A same-origin frame can read the top-level location; the relay must still not
    // pass page-derived values to the extension.
    top: { location: { hostname: 'news.example' } }
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(payload, callback) {
        sent.push(payload);
        callback();
      }
    }
  };
  const context = vm.createContext({ window, chrome });
  vm.runInContext(relaySource, context, { filename: 'fingerprint-relay.js' });
  const probePort = {
    onmessage: null,
    start() {},
    send(data) {
      this.onmessage({ data });
    }
  };
  channelListener({
    data: { source: 'domainscan-probe' },
    ports: [probePort]
  });

  return {
    dispatch(data) {
      probePort.send(data);
    },
    installChannel(port, source = 'domainscan-probe') {
      channelListener({ data: { source }, ports: [port] });
    },
    sent,
    window
  };
}

test('relay forwards every approved signal using the canonical single-signal payload', () => {
  const harness = createRelayHarness();

  for (const signal of SIGNALS) {
    harness.dispatch({ signal });
  }

  assert.deepEqual(
    harness.sent.map(({ type, signal }) => ({ type, signal })),
    SIGNALS.map((signal) => ({ type: 'FINGERPRINT', signal }))
  );
});

test('relay forwards each approved signal at most once per frame document', () => {
  const harness = createRelayHarness();

  harness.dispatch({ signal: 'timezone' });
  harness.dispatch({ signal: 'timezone' });

  assert.deepEqual(
    harness.sent.map(({ type, signal }) => ({ type, signal })),
    [{ type: 'FINGERPRINT', signal: 'timezone' }]
  );
});

test('relay rejects a replacement channel and unknown signal vocabulary', () => {
  const harness = createRelayHarness();
  const replacement = {
    onmessage: null,
    start() {},
    send(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  };
  harness.installChannel(replacement);
  replacement.send({ signal: 'geolocation' });
  harness.dispatch({ signal: 'canvas' });
  harness.dispatch({ signal: '__proto__' });
  harness.dispatch(null);

  assert.deepEqual(harness.sent, []);
});

const INSTRUMENTED_SOURCES = [
  'CanvasRenderingContext2D.prototype.getImageData',
  'HTMLCanvasElement.prototype.toDataURL',
  'HTMLCanvasElement.prototype.toBlob',
  'WebGLRenderingContext.prototype.getParameter',
  'WebGL2RenderingContext.prototype.getParameter',
  'AnalyserNode.prototype.getFloatFrequencyData',
  'AnalyserNode.prototype.getByteFrequencyData',
  'Intl.DateTimeFormat.prototype.resolvedOptions',
  'Date.prototype.getTimezoneOffset',
  'Geolocation.prototype.getCurrentPosition',
  'Geolocation.prototype.watchPosition',
  'NavigatorUAData.prototype.getHighEntropyValues',
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'language').get",
  "Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages').get"
];

test('instrumented APIs report the source of the function they replaced', () => {
  const pristine = createProbeHarness({ install: false });
  const probed = createProbeHarness();

  for (const expression of INSTRUMENTED_SOURCES) {
    const code = `Function.prototype.toString.call(${expression})`;
    assert.equal(probed.evaluate(code), pristine.evaluate(code), expression);
  }
});

test('the source concealment itself reports as an untouched function', () => {
  const pristine = createProbeHarness({ install: false });
  const probed = createProbeHarness();

  const selfCode = 'Function.prototype.toString.call(Function.prototype.toString)';
  assert.equal(probed.evaluate(selfCode), pristine.evaluate(selfCode));

  const descriptorCode = `(() => {
    const d = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
    return JSON.stringify({
      configurable: d.configurable,
      enumerable: d.enumerable,
      writable: d.writable,
      name: d.value.name,
      length: d.value.length
    });
  })()`;
  assert.equal(probed.evaluate(descriptorCode), pristine.evaluate(descriptorCode));
});

test('concealed toString still throws for values that are not functions', () => {
  const probed = createProbeHarness();

  assert.equal(
    probed.evaluate(`(() => {
      try {
        Function.prototype.toString.call({});
        return 'no throw';
      } catch (error) {
        return error.constructor.name;
      }
    })()`),
    'TypeError'
  );
});

test('relay sends nothing but the message type and the signal name', () => {
  const harness = createRelayHarness();

  harness.dispatch({ signal: 'timezone' });

  assert.deepEqual(Object.keys(harness.sent[0]).sort(), ['signal', 'type']);
});
