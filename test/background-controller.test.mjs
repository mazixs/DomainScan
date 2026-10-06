import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MSG, PORT_NAME } from '../src/common/messages.js';
import { createBackgroundController } from '../src/background/controller.js';
import { buildDestinationRows, captureCheckpoint } from '../src/sidepanel/view-model.js';

function fakeEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function fakePort(name = PORT_NAME) {
  return {
    name,
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
    sent: [],
    postMessage(message) {
      this.sent.push(structuredClone(message));
    },
    receive(message) {
      this.onMessage.emit(message);
    },
    disconnect() {
      this.onDisconnect.emit();
    }
  };
}

function fakeChrome(initialStorage = {}, initialLocal = {}, initialScripts = []) {
  const storage = structuredClone(initialStorage);
  const local = structuredClone(initialLocal);
  const counters = { writes: 0 };
  const scriptingCalls = [];
  let registeredScripts = structuredClone(initialScripts);
  return {
    storageData: storage,
    localData: local,
    counters,
    scriptingCalls,
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        return structuredClone(registeredScripts.filter((script) => !ids || ids.includes(script.id)));
      },
      async registerContentScripts(scripts) {
        scriptingCalls.push({ call: 'register', scripts: structuredClone(scripts) });
        registeredScripts = [...registeredScripts, ...structuredClone(scripts)];
      },
      async updateContentScripts(scripts) {
        scriptingCalls.push({ call: 'update', scripts: structuredClone(scripts) });
        registeredScripts = registeredScripts.map((script) => ({ ...script, ...structuredClone(scripts.find((update) => update.id === script.id) || {}) }));
      },
      async unregisterContentScripts({ ids }) {
        scriptingCalls.push({ call: 'unregister', ids: structuredClone(ids) });
        registeredScripts = registeredScripts.filter((script) => !ids.includes(script.id));
      }
    },
    webRequest: {
      onBeforeRequest: fakeEvent(),
      onResponseStarted: fakeEvent(),
      onCompleted: fakeEvent(),
      onErrorOccurred: fakeEvent()
    },
    runtime: {
      onConnect: fakeEvent(),
      onMessage: fakeEvent(),
      onInstalled: fakeEvent(),
      onStartup: fakeEvent()
    },
    tabs: {
      onRemoved: fakeEvent(),
      onUpdated: fakeEvent(),
      openTabs: [],
      async query() {
        return structuredClone(this.openTabs);
      }
    },
    sidePanel: {
      calls: [],
      async setPanelBehavior(options) {
        this.calls.push(options);
      }
    },
    storage: {
      local: {
        async get() {
          return structuredClone(local);
        },
        async set(values) {
          Object.assign(local, structuredClone(values));
        }
      },
      session: {
        async get() {
          return structuredClone(storage);
        },
        async set(values) {
          counters.writes += 1;
          Object.assign(storage, structuredClone(values));
        },
        async remove(key) {
          delete storage[key];
        }
      }
    }
  };
}

// Waits for the controller's own delivery instead of forcing it with flush().
async function waitFor(condition, description, timeout = 2000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

function lastState(port) {
  return port.sent.filter((message) => message.type === MSG.STATE).at(-1)?.state;
}

let requestSequence = 0;
function request(chrome, tabId, url, type = 'script', requestId = `request-${++requestSequence}`) {
  chrome.webRequest.onBeforeRequest.emit({ tabId, url, type, requestId });
  return requestId;
}

// A committed navigation: Chrome first reports the document request, then the tab
// URL changes once the document is committed.
function navigate(chrome, tabId, url, documentId) {
  const requestId = `navigation-${++requestSequence}`;
  chrome.webRequest.onBeforeRequest.emit({
    tabId, url, type: 'main_frame', requestId, documentId
  });
  chrome.tabs.onUpdated.emit(tabId, { url, status: 'loading' }, { id: tabId, url });
  return requestId;
}

test('a panel port can rebind between tabs without receiving stale tab updates', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);

  port.receive({ type: MSG.HELLO, tabId: 11 });
  await controller.flush();
  assert.equal(lastState(port).tabId, 11);

  navigate(chrome, 11, 'https://one.alpha.test/');
  await controller.flush();
  assert.equal(lastState(port).pageHost, 'one.alpha.test');

  port.receive({ type: MSG.HELLO, tabId: 12 });
  await controller.flush();
  const sentAfterRebind = port.sent.length;
  request(chrome, 11, 'https://cdn.alpha.test/a.js');
  await controller.flush();
  assert.equal(port.sent.length, sentAfterRebind);

  navigate(chrome, 12, 'https://one.beta.test/');
  await controller.flush();
  assert.equal(lastState(port).tabId, 12);
  assert.equal(lastState(port).pageHost, 'one.beta.test');
});

test('ports bound to the same tab all receive state and disconnect independently', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const first = fakePort();
  const second = fakePort();
  chrome.runtime.onConnect.emit(first);
  chrome.runtime.onConnect.emit(second);
  first.receive({ type: MSG.HELLO, tabId: 3 });
  second.receive({ type: MSG.HELLO, tabId: 3 });
  await controller.flush();

  first.disconnect();
  navigate(chrome, 3, 'https://example.com/');
  await controller.flush();

  assert.equal(lastState(first).pageHost, null);
  assert.equal(lastState(second).pageHost, 'example.com');
});

test('same-site navigation accumulates while cross-site navigation resets evidence', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 5 });

  navigate(chrome, 5, 'https://one.alpha.test/a');
  request(chrome, 5, 'https://cdn.alpha.test/a.js');
  navigate(chrome, 5, 'https://two.alpha.test/b');
  await controller.flush();
  assert.ok(lastState(port).destinations['host|cdn.alpha.test']);

  navigate(chrome, 5, 'https://one.beta.test/');
  await controller.flush();
  assert.equal(lastState(port).siteKey, 'beta.test');
  assert.equal(lastState(port).destinations['host|cdn.alpha.test'], undefined);
});

test('pause blocks network, IP, and fingerprint capture but still follows cross-site navigation', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 8 });
  navigate(chrome, 8, 'https://one.alpha.test/');
  await controller.flush();

  port.receive({ type: MSG.SET_PAUSED, paused: true });
  request(chrome, 8, 'https://cdn.alpha.test/a.js');
  chrome.webRequest.onResponseStarted.emit({
    tabId: 8,
    url: 'https://one.alpha.test/',
    ip: '203.0.113.8',
    requestId: 'request-without-capture'
  });
  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    { tab: { id: 8 }, frameId: 0 }
  );
  await controller.flush();

  assert.equal(lastState(port).destinations['host|cdn.alpha.test'], undefined);
  assert.deepEqual(lastState(port).fingerprint.signals, {});

  navigate(chrome, 8, 'https://one.beta.test/');
  await controller.flush();
  assert.equal(lastState(port).siteKey, 'beta.test');
  assert.deepEqual(lastState(port).destinations, {});
  assert.equal(lastState(port).paused, true);
});

test('response IPs enrich the matching host with complete history', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const firstRequestId = request(chrome, 2, 'https://cdn.example.com/a.js');
  chrome.webRequest.onResponseStarted.emit({
    tabId: 2,
    url: 'https://cdn.example.com/a.js',
    ip: '2001:0DB8:0:0:0:0:0:1',
    requestId: firstRequestId
  });
  const secondRequestId = request(chrome, 2, 'https://cdn.example.com/a.js');
  chrome.webRequest.onResponseStarted.emit({
    tabId: 2,
    url: 'https://cdn.example.com/a.js',
    ip: '2001:db8::1',
    requestId: secondRequestId
  });
  await controller.flush();

  const ips = controller.getState(2).destinations['host|cdn.example.com'].ips;
  assert.deepEqual(Object.keys(ips), ['2001:db8::1']);
  assert.equal(ips['2001:db8::1'].count, 2);
});

test('a late response from the previous site cannot enrich the new site session', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 2, 'https://one.alpha.test/');
  const oldRequestId = request(chrome, 2, 'https://cdn.shared.test/old.js');
  navigate(chrome, 2, 'https://one.beta.test/');
  const newRequestId = request(chrome, 2, 'https://cdn.shared.test/new.js');

  chrome.webRequest.onResponseStarted.emit({
    tabId: 2,
    url: 'https://cdn.shared.test/old.js',
    ip: '203.0.113.10',
    requestId: oldRequestId
  });
  await controller.flush();
  assert.deepEqual(
    controller.getState(2).destinations['host|cdn.shared.test'].ips,
    {}
  );

  chrome.webRequest.onResponseStarted.emit({
    tabId: 2,
    url: 'https://cdn.shared.test/new.js',
    ip: '203.0.113.11',
    requestId: newRequestId
  });
  await controller.flush();
  assert.deepEqual(
    Object.keys(controller.getState(2).destinations['host|cdn.shared.test'].ips),
    ['203.0.113.11']
  );
});

test('a late signal from the previous document cannot attach to the new site session', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;

  navigate(chrome, 19, 'https://one.alpha.test/', 'document-old');
  navigate(chrome, 19, 'https://one.beta.test/', 'document-new');
  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    { tab: { id: 19, url: 'https://one.beta.test/' }, frameId: 0, documentId: 'document-old' }
  );
  await controller.flush();
  assert.deepEqual(controller.getState(19).fingerprint.signals, {});

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'language' },
    { tab: { id: 19, url: 'https://one.beta.test/' }, frameId: 0, documentId: 'document-new' }
  );
  await controller.flush();
  assert.ok(controller.getState(19).fingerprint.signals.language);
});

test('clear removes all site evidence and tab removal deletes persisted state', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 6 });
  navigate(chrome, 6, 'https://example.com/');
  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    { tab: { id: 6 }, frameId: 0 }
  );
  await controller.flush();

  port.receive({ type: MSG.CLEAR });
  await controller.flush();
  assert.deepEqual(lastState(port).destinations, {});
  assert.deepEqual(lastState(port).fingerprint.signals, {});

  chrome.tabs.onRemoved.emit(6);
  await controller.flush();
  assert.equal(controller.getState(6), undefined);
  assert.equal(chrome.storageData['tab:6'], undefined);
});

test('tab removal waits for an in-flight state write before deleting storage', async () => {
  const chrome = fakeChrome();
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  chrome.storage.session.set = async (values) => {
    markWriteStarted();
    await writeGate;
    Object.assign(chrome.storageData, structuredClone(values));
  };

  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 17, 'https://example.com/');
  await writeStarted;

  chrome.tabs.onRemoved.emit(17);
  await Promise.resolve();
  releaseWrite();
  await controller.flush();

  assert.equal(controller.getState(17), undefined);
  assert.equal(chrome.storageData['tab:17'], undefined);
});

test('panel is warned of a failed session write and informed after recovery', async () => {
  const chrome = fakeChrome();
  let failWrite = true;
  const actualSet = chrome.storage.session.set.bind(chrome.storage.session);
  chrome.storage.session.set = async (values) => {
    if (failWrite) throw new Error('quota exceeded');
    return actualSet(values);
  };
  const controller = createBackgroundController(chrome, { logger: { warn() {} } });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 21 });
  await controller.flush();

  port.receive({ type: MSG.SET_PAUSED, paused: true });
  await controller.flush();
  assert.equal(port.sent.at(-1).storageWriteFailed, true);

  failWrite = false;
  port.receive({ type: MSG.SET_PAUSED, paused: false });
  await controller.flush();
  assert.equal(port.sent.at(-1).storageWriteFailed, false);
});

test('checkpoint response includes requests queued before the marker', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome, { now: () => 500 });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 22 });
  navigate(chrome, 22, 'https://example.com/');
  request(chrome, 22, 'https://cdn.vendor.test/one.js');
  port.receive({ type: MSG.CHECKPOINT_REQUEST });
  request(chrome, 22, 'https://cdn.vendor.test/two.js');
  await controller.flush();

  const marker = port.sent.find((message) => message.type === MSG.CHECKPOINT_READY);
  assert.equal(marker.tabId, 22);
  assert.equal(marker.at, 500);
  assert.equal(marker.state.destinations['host|cdn.vendor.test'].count, 1);
  assert.equal(controller.getState(22).destinations['host|cdn.vendor.test'].count, 2);
});

test('rehydration completes before queued capture and migrates legacy state', async () => {
  const chrome = fakeChrome({
    'tab:4': {
      tabId: 4,
      pageUrl: 'https://example.com/private',
      pageHost: 'example.com',
      destinations: {},
      fingerprint: { canvas: true, webgl: false, audio: false, firstSeen: 10 },
      paused: false,
      updatedAt: 10
    }
  });
  const controller = createBackgroundController(chrome);
  request(chrome, 4, 'https://cdn.example.com/a.js');
  await controller.flush();

  const state = controller.getState(4);
  assert.equal(state.siteKey, 'example.com');
  assert.ok(state.destinations['host|cdn.example.com']);
  assert.ok(state.fingerprint.signals.canvas_readback);
});

test('an uncommitted cross-site navigation keeps the current site session', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 31, 'https://shop.alpha.test/');
  request(chrome, 31, 'https://cdn.alpha.test/a.js');
  await controller.flush();

  // A download: the document request is made, but the tab never commits it.
  request(chrome, 31, 'https://files.gamma.test/file.zip', 'main_frame');
  await controller.flush();

  const state = controller.getState(31);
  assert.equal(state.siteKey, 'alpha.test');
  assert.equal(state.pageHost, 'shop.alpha.test');
  assert.ok(state.destinations['host|cdn.alpha.test']);
  assert.ok(state.destinations['host|files.gamma.test']);
});

test('a committed navigation records the document and its resolved IP', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;

  const requestId = 'navigation-with-ip';
  chrome.webRequest.onBeforeRequest.emit({
    tabId: 32, url: 'https://one.alpha.test/', type: 'main_frame', requestId
  });
  chrome.webRequest.onResponseStarted.emit({
    tabId: 32, url: 'https://one.alpha.test/', ip: '203.0.113.20', requestId
  });
  chrome.tabs.onUpdated.emit(32, { url: 'https://one.alpha.test/' }, { id: 32, url: 'https://one.alpha.test/' });
  await controller.flush();

  const document = controller.getState(32).destinations['host|one.alpha.test'];
  assert.equal(controller.getState(32).siteKey, 'alpha.test');
  assert.ok(document, 'the committed document is recorded as a destination');
  assert.deepEqual(Object.keys(document.ips), ['203.0.113.20']);
});

test('a navigation committed without an observed request invents no destination', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;

  // Back-forward cache restore: the tab URL changes with no network request.
  chrome.tabs.onUpdated.emit(33, { url: 'https://one.alpha.test/' }, { id: 33, url: 'https://one.alpha.test/' });
  await controller.flush();

  assert.equal(controller.getState(33).siteKey, 'alpha.test');
  assert.deepEqual(controller.getState(33).destinations, {});
});

test('open tabs are seeded from the browser before queued events are captured', async () => {
  const chrome = fakeChrome();
  chrome.tabs.openTabs = [
    { id: 34, url: 'https://one.alpha.test/inbox' },
    { id: 35, url: 'chrome://settings' }
  ];
  const controller = createBackgroundController(chrome);
  request(chrome, 34, 'https://cdn.alpha.test/a.js');
  await controller.flush();

  assert.equal(controller.getState(34).siteKey, 'alpha.test');
  assert.equal(controller.getState(34).pageHost, 'one.alpha.test');
  assert.ok(controller.getState(34).destinations['host|cdn.alpha.test']);
  assert.equal(controller.getState(35), undefined);
});

test('seeding follows a navigation that happened while the worker was gone', async () => {
  const chrome = fakeChrome({
    'tab:36': {
      tabId: 36,
      siteKey: 'alpha.test',
      pageUrl: 'https://one.alpha.test',
      pageHost: 'one.alpha.test',
      destinations: {
        'host|cdn.alpha.test': {
          id: 'host|cdn.alpha.test', kind: 'host', value: 'cdn.alpha.test',
          party: 'third', requestType: 'script', transport: 'https',
          ips: {}, firstSeen: 10, lastSeen: 10, count: 1
        }
      },
      fingerprint: { signals: {} },
      paused: false,
      updatedAt: 10
    }
  });
  chrome.tabs.openTabs = [{ id: 36, url: 'https://one.beta.test/' }];
  const controller = createBackgroundController(chrome);
  await controller.ready;

  assert.equal(controller.getState(36).siteKey, 'beta.test');
  assert.deepEqual(controller.getState(36).destinations, {});
});

test('a signal from a cross-origin frame binds to the top-level tab URL', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  chrome.tabs.onUpdated.emit(37, { url: 'https://one.alpha.test/' }, { id: 37, url: 'https://one.alpha.test/' });
  await controller.flush();

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'canvas_readback' },
    { tab: { id: 37, url: 'https://one.alpha.test/' }, frameId: 7 }
  );
  await controller.flush();
  assert.ok(
    controller.getState(37).fingerprint.signals.canvas_readback,
    'a third-party frame of the current page is still evidence for this site'
  );

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    { tab: { id: 37, url: 'https://one.beta.test/' }, frameId: 7 }
  );
  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'language' },
    { tab: { id: 37 }, frameId: 7 }
  );
  await controller.flush();
  assert.equal(controller.getState(37).fingerprint.signals.timezone, undefined);
  assert.equal(controller.getState(37).fingerprint.signals.language, undefined);
});

test('a burst of requests is written and pushed once without losing any of it', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 41 });
  navigate(chrome, 41, 'https://one.alpha.test/');
  await controller.flush();

  const writesBefore = chrome.counters.writes;
  const statesBefore = port.sent.filter((message) => message.type === MSG.STATE).length;
  for (const host of ['a', 'b', 'c', 'd', 'e']) {
    request(chrome, 41, `https://${host}.alpha.test/asset`);
  }
  await controller.flush();

  const writes = chrome.counters.writes - writesBefore;
  const states = port.sent.filter((message) => message.type === MSG.STATE).length - statesBefore;
  assert.equal(writes, 1, `five requests must not cost five writes, got ${writes}`);
  assert.equal(states, 1, `five requests must not cost five panel updates, got ${states}`);

  const destinations = Object.keys(lastState(port).destinations).sort();
  assert.deepEqual(destinations, [
    'host|a.alpha.test',
    'host|b.alpha.test',
    'host|c.alpha.test',
    'host|d.alpha.test',
    'host|e.alpha.test',
    'host|one.alpha.test'
  ]);
  assert.deepEqual(
    Object.keys(chrome.storageData['tab:41'].destinations).sort(),
    destinations
  );
});

test('a tab closed before a pending write lands leaves nothing behind', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 42, 'https://one.alpha.test/');
  await controller.flush();

  request(chrome, 42, 'https://cdn.alpha.test/a.js');
  chrome.tabs.onRemoved.emit(42);
  await controller.flush();

  assert.equal(controller.getState(42), undefined);
  assert.equal(chrome.storageData['tab:42'], undefined);
});

test('an update about the page being left does not consume the pending navigation', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 51, 'https://one.alpha.test/', 'document-alpha');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: 51,
    url: 'https://one.beta.test/',
    type: 'main_frame',
    requestId: 'navigation-beta',
    documentId: 'document-beta'
  });
  chrome.webRequest.onResponseStarted.emit({
    tabId: 51,
    url: 'https://one.beta.test/',
    ip: '203.0.113.30',
    requestId: 'navigation-beta'
  });
  // The page being left keeps ticking its title while the new one is still loading.
  chrome.tabs.onUpdated.emit(51, { title: '(3) inbox' }, { id: 51, url: 'https://one.alpha.test/' });
  chrome.tabs.onUpdated.emit(51, { favIconUrl: 'https://one.alpha.test/i.png' }, { id: 51, url: 'https://one.alpha.test/' });
  await controller.flush();

  chrome.tabs.onUpdated.emit(
    51,
    { url: 'https://one.beta.test/', status: 'loading' },
    { id: 51, url: 'https://one.beta.test/' }
  );
  await controller.flush();

  const state = controller.getState(51);
  assert.equal(state.siteKey, 'beta.test');
  const document = state.destinations['host|one.beta.test'];
  assert.ok(document, 'the document of the site that committed is recorded');
  assert.deepEqual(Object.keys(document.ips), ['203.0.113.30']);
});

test('a signal from a document that is no longer active is dropped', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 53, 'https://one.alpha.test/', 'document-alpha');
  await controller.flush();

  // No request accompanies this navigation, so the current document is unknown.
  chrome.tabs.onUpdated.emit(
    53,
    { url: 'https://two.alpha.test/', status: 'loading' },
    { id: 53, url: 'https://two.alpha.test/' }
  );
  await controller.flush();

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'canvas_readback' },
    {
      tab: { id: 53, url: 'https://two.alpha.test/' },
      frameId: 0,
      documentId: 'document-alpha',
      documentLifecycle: 'cached'
    }
  );
  await controller.flush();

  assert.deepEqual(controller.getState(53).fingerprint.signals, {});
});

test('a restored document may report signals when its own request was never seen', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 54, 'https://one.alpha.test/', 'document-alpha');
  navigate(chrome, 54, 'https://two.alpha.test/', 'document-two');
  await controller.flush();

  chrome.tabs.onUpdated.emit(
    54,
    { url: 'https://one.alpha.test/', status: 'loading' },
    { id: 54, url: 'https://one.alpha.test/' }
  );
  await controller.flush();

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    {
      tab: { id: 54, url: 'https://one.alpha.test/' },
      frameId: 0,
      documentId: 'document-alpha',
      documentLifecycle: 'active'
    }
  );
  await controller.flush();

  assert.ok(controller.getState(54).fingerprint.signals.timezone);
});

test('a reload rebinds the document a signal must come from', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 55, 'https://one.alpha.test/', 'document-first');
  await controller.flush();

  // A reload keeps the URL, so Chrome reports progress instead of a URL change.
  chrome.webRequest.onBeforeRequest.emit({
    tabId: 55,
    url: 'https://one.alpha.test/',
    type: 'main_frame',
    requestId: 'reload-request',
    documentId: 'document-second'
  });
  chrome.tabs.onUpdated.emit(55, { status: 'complete' }, { id: 55, url: 'https://one.alpha.test/' });
  await controller.flush();

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone' },
    {
      tab: { id: 55, url: 'https://one.alpha.test/' },
      frameId: 0,
      documentId: 'document-second',
      documentLifecycle: 'active'
    }
  );
  await controller.flush();

  assert.ok(controller.getState(55).fingerprint.signals.timezone);
});

test('a tab that leaves the web keeps no site and no evidence', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 56, 'https://one.alpha.test/');
  request(chrome, 56, 'https://cdn.alpha.test/a.js');
  await controller.flush();

  chrome.tabs.onUpdated.emit(
    56,
    { url: 'chrome://settings/', status: 'loading' },
    { id: 56, url: 'chrome://settings/' }
  );
  await controller.flush();

  const state = controller.getState(56);
  assert.equal(state.siteKey, null);
  assert.equal(state.pageHost, null);
  assert.deepEqual(state.destinations, {});
});

test('seeding forgets a stored site when the tab is no longer on the web', async () => {
  const chrome = fakeChrome({
    'tab:57': {
      tabId: 57,
      siteKey: 'alpha.test',
      pageUrl: 'https://one.alpha.test',
      pageHost: 'one.alpha.test',
      destinations: {
        'host|cdn.alpha.test': {
          id: 'host|cdn.alpha.test', kind: 'host', value: 'cdn.alpha.test',
          party: 'third', requestType: 'script', transport: 'https',
          ips: {}, firstSeen: 10, lastSeen: 10, count: 1
        }
      },
      fingerprint: { signals: {} },
      paused: false,
      updatedAt: 10
    }
  });
  chrome.tabs.openTabs = [{ id: 57, url: 'chrome://extensions/' }];
  const controller = createBackgroundController(chrome);
  await controller.ready;

  assert.equal(controller.getState(57).siteKey, null);
  assert.deepEqual(controller.getState(57).destinations, {});
});

test('accumulated evidence reaches the panel and storage without a forced flush', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 61 });
  navigate(chrome, 61, 'https://one.alpha.test/');
  await controller.flush();

  request(chrome, 61, 'https://cdn.alpha.test/a.js');
  await waitFor(
    () => {
      const stored = chrome.storageData['tab:61'];
      const state = lastState(port);
      return !!(stored && stored.destinations['host|cdn.alpha.test']) &&
        !!(state && state.destinations['host|cdn.alpha.test']);
    },
    'the controller to deliver a captured destination on its own'
  );
});

test('a request made by the site service worker is attributed to the tab showing that site', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 71, 'https://app.pwa.test/');
  await controller.flush();

  // A service worker serving the page goes to the network itself: no tab is named.
  chrome.webRequest.onBeforeRequest.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'worker-request',
    initiator: 'https://app.pwa.test'
  });
  chrome.webRequest.onResponseStarted.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    ip: '203.0.113.44',
    requestId: 'worker-request'
  });
  await controller.flush();

  const destination = controller.getState(71).destinations['host|api.vendor.test'];
  assert.ok(destination, 'the destination the service worker contacted is recorded');
  assert.deepEqual(destination.sources, ['worker']);
  assert.equal(destination.party, 'third');
  assert.deepEqual(Object.keys(destination.ips), ['203.0.113.44']);
});

test('worker traffic reaches every tab showing that origin and no other', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 72, 'https://app.pwa.test/');
  navigate(chrome, 73, 'https://app.pwa.test/inbox');
  navigate(chrome, 74, 'https://blog.pwa.test/');
  navigate(chrome, 75, 'https://other.test/');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'worker-fanout',
    initiator: 'https://app.pwa.test'
  });
  await controller.flush();

  assert.ok(controller.getState(72).destinations['host|api.vendor.test']);
  assert.ok(controller.getState(73).destinations['host|api.vendor.test']);
  // A service worker belongs to one origin: another host of the same site is not it.
  assert.equal(controller.getState(74).destinations['host|api.vendor.test'], undefined);
  assert.equal(controller.getState(75).destinations['host|api.vendor.test'], undefined);
});

test('worker traffic with no tab showing that origin is dropped', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;

  chrome.webRequest.onBeforeRequest.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'orphan-worker',
    initiator: 'https://closed.pwa.test'
  });
  await controller.flush();

  assert.deepEqual(Object.keys(chrome.storageData), []);
});

test('a browser-internal request without a page origin is ignored', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 76, 'https://app.pwa.test/');
  await controller.flush();

  for (const initiator of [undefined, null, 'chrome-extension://abcdefghijklmnop', 'chrome://settings']) {
    chrome.webRequest.onBeforeRequest.emit({
      tabId: -1,
      url: 'https://telemetry.browser.test/ping',
      type: 'xmlhttprequest',
      requestId: `internal-${String(initiator)}`,
      initiator
    });
  }
  await controller.flush();

  assert.equal(controller.getState(76).destinations['host|telemetry.browser.test'], undefined);
});

test('a paused tab records no worker traffic', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 77 });
  navigate(chrome, 77, 'https://app.pwa.test/');
  port.receive({ type: MSG.SET_PAUSED, paused: true });
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'paused-worker',
    initiator: 'https://app.pwa.test'
  });
  await controller.flush();

  assert.equal(controller.getState(77).destinations['host|api.vendor.test'], undefined);
});

test('a destination contacted both by the page and by its worker states both', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 78, 'https://app.pwa.test/');
  request(chrome, 78, 'https://api.vendor.test/data');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: -1,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'both-worker',
    initiator: 'https://app.pwa.test'
  });
  await controller.flush();

  const destination = controller.getState(78).destinations['host|api.vendor.test'];
  assert.deepEqual(destination.sources, ['page', 'worker']);
  assert.equal(destination.count, 2);
});

function lastMessage(port, type) {
  return port.sent.filter((message) => message.type === type).at(-1);
}

test('page instrumentation is registered on start and reported to the panel', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 81 });
  await controller.flush();

  const registered = chrome.scriptingCalls.filter((entry) => entry.call === 'register');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].scripts.length, 2);
  assert.deepEqual(registered[0].scripts[0].js, ['src/content/fingerprint-relay.js']);
  assert.equal(registered[0].scripts[0].world, 'ISOLATED');
  assert.deepEqual(registered[0].scripts[1].js, ['src/content/fingerprint-probe.js']);
  assert.equal(registered[0].scripts[1].world, 'MAIN');
  assert.equal(registered[0].scripts[0].runAt, 'document_start');
  assert.deepEqual(registered[0].scripts[0].excludeMatches, []);
  assert.deepEqual(lastMessage(port, MSG.STATE).settings, {
    observePageApis: true,
    excludedSites: []
  });
});

test('turning page instrumentation off unregisters it and remembers the choice', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 82 });
  await controller.flush();

  port.receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();

  assert.deepEqual(
    chrome.scriptingCalls.filter((entry) => entry.call === 'unregister').at(-1).ids,
    ['domainscan-signal-relay', 'domainscan-page-probe']
  );
  assert.equal(lastMessage(port, MSG.STATE).settings.observePageApis, false);
  assert.equal(chrome.localData.settings.observePageApis, false);

  port.receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: true });
  await controller.flush();
  assert.ok(chrome.scriptingCalls.filter((entry) => entry.call === 'register').length >= 2);
  assert.equal(lastMessage(port, MSG.STATE).settings.observePageApis, true);
});

test('excluding the current site keeps instrumentation everywhere else', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 83 });
  navigate(chrome, 83, 'https://login.example.com/');
  await controller.flush();

  port.receive({ type: MSG.SET_SITE_OBSERVED, observed: false });
  await controller.flush();

  const update = chrome.scriptingCalls.filter((entry) => entry.call === 'update').at(-1);
  assert.deepEqual(update.scripts[0].excludeMatches, [
    '*://example.com/*',
    '*://*.example.com/*'
  ]);
  assert.deepEqual(lastMessage(port, MSG.STATE).settings.excludedSites, ['example.com']);
  assert.deepEqual(chrome.localData.settings.excludedSites, ['example.com']);

  port.receive({ type: MSG.SET_SITE_OBSERVED, observed: true });
  await controller.flush();
  assert.deepEqual(
    chrome.scriptingCalls.filter((entry) => entry.call === 'update').at(-1).scripts[0].excludeMatches,
    []
  );
});

test('a remembered choice is applied before any page is instrumented', async () => {
  const chrome = fakeChrome({}, {
    settings: { observePageApis: true, excludedSites: ['mts.ru'] }
  });
  const controller = createBackgroundController(chrome);
  await controller.ready;

  const registered = chrome.scriptingCalls.filter((entry) => entry.call === 'register').at(-1);
  assert.deepEqual(registered.scripts[0].excludeMatches, ['*://mts.ru/*', '*://*.mts.ru/*']);
});

test('a signal from an excluded site is refused even if something still reports one', async () => {
  const chrome = fakeChrome({}, {
    settings: { observePageApis: true, excludedSites: ['example.com'] }
  });
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 84, 'https://login.example.com/', 'document-login');
  await controller.flush();

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'canvas_readback' },
    {
      tab: { id: 84, url: 'https://login.example.com/' },
      frameId: 0,
      documentId: 'document-login',
      documentLifecycle: 'active'
    }
  );
  await controller.flush();

  assert.deepEqual(controller.getState(84).fingerprint.signals, {});
});

test('a request from a document that is being torn down belongs to no site', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 91, 'https://one.alpha.test/');
  await controller.flush();
  navigate(chrome, 91, 'https://one.gamma.test/');
  await controller.flush();

  // The page being left fires its beacon after the new page has committed.
  chrome.webRequest.onBeforeRequest.emit({
    tabId: 91,
    url: 'https://analytics.alpha.test/collect',
    type: 'ping',
    requestId: 'unload-beacon',
    initiator: 'https://one.alpha.test',
    frameType: 'outermost_frame',
    documentLifecycle: 'pending_deletion'
  });
  await controller.flush();

  assert.equal(controller.getState(91).destinations['host|analytics.alpha.test'], undefined);
});

test('a prerendered page contacts destinations for a tab that is not showing it', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 92, 'https://one.alpha.test/');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: 92,
    url: 'https://cdn.gamma.test/app.js',
    type: 'script',
    requestId: 'prerender-request',
    initiator: 'https://one.gamma.test',
    frameType: 'outermost_frame',
    documentLifecycle: 'prerender'
  });
  await controller.flush();

  assert.equal(controller.getState(92).destinations['host|cdn.gamma.test'], undefined);
  assert.equal(controller.getState(92).siteKey, 'alpha.test');
});

test('a navigation that never loads leaves the site it failed to leave', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 93, 'https://one.alpha.test/');
  request(chrome, 93, 'https://cdn.alpha.test/a.js');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: 93,
    url: 'https://does-not-resolve.invalid/',
    type: 'main_frame',
    requestId: 'failed-navigation'
  });
  chrome.webRequest.onErrorOccurred.emit({
    tabId: 93,
    url: 'https://does-not-resolve.invalid/',
    type: 'main_frame',
    requestId: 'failed-navigation',
    error: 'net::ERR_NAME_NOT_RESOLVED'
  });
  // Chrome still reports the failed address as the tab URL of its error page.
  chrome.tabs.onUpdated.emit(
    93,
    { url: 'https://does-not-resolve.invalid/', status: 'loading' },
    { id: 93, url: 'https://does-not-resolve.invalid/' }
  );
  await controller.flush();

  const state = controller.getState(93);
  assert.equal(state.siteKey, 'alpha.test');
  assert.equal(state.pageHost, 'one.alpha.test');
  assert.ok(state.destinations['host|cdn.alpha.test'], 'the record of the site survives');
  assert.ok(state.destinations['host|does-not-resolve.invalid'], 'the attempt itself stays visible');
});

test('a page reporting itself through its own requests corrects a missed navigation', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 94, 'https://one.alpha.test/');
  request(chrome, 94, 'https://cdn.alpha.test/a.js');
  await controller.flush();

  // No commit arrives for the new page; its own request says where the tab is.
  chrome.webRequest.onBeforeRequest.emit({
    tabId: 94,
    url: 'https://cdn.gamma.test/app.js',
    type: 'script',
    requestId: 'orphan-subresource',
    initiator: 'https://one.gamma.test',
    frameType: 'outermost_frame',
    documentLifecycle: 'active'
  });
  await controller.flush();

  const state = controller.getState(94);
  assert.equal(state.siteKey, 'gamma.test');
  assert.equal(state.pageHost, 'one.gamma.test');
  assert.equal(state.destinations['host|cdn.alpha.test'], undefined, 'the previous site is not mixed in');
  assert.ok(state.destinations['host|cdn.gamma.test']);
});

test('a third-party frame does not pass for a navigation', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 95, 'https://one.alpha.test/');
  await controller.flush();

  chrome.webRequest.onBeforeRequest.emit({
    tabId: 95,
    url: 'https://api.vendor.test/data',
    type: 'xmlhttprequest',
    requestId: 'frame-request',
    initiator: 'https://widget.gamma.test',
    frameType: 'sub_frame',
    parentDocumentId: 'document-alpha',
    documentLifecycle: 'active'
  });
  await controller.flush();

  const state = controller.getState(95);
  assert.equal(state.siteKey, 'alpha.test', 'a frame of another origin is part of this page');
  assert.ok(state.destinations['host|api.vendor.test']);
});

test('captures URL ports for committed navigation, page and worker requests with IP association', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 71 });
  const navigation = request(chrome, 71, 'https://site.example:8443/', 'main_frame');
  chrome.webRequest.onResponseStarted.emit({ tabId: 71, requestId: navigation, url: 'https://site.example:8443/', ip: '192.0.2.10' });
  chrome.tabs.onUpdated.emit(71, { url: 'https://site.example:8443/', status: 'loading' });
  request(chrome, 71, 'wss://socket.example:9443/', 'websocket');
  request(chrome, 71, 'https://socket.example/', 'xmlhttprequest');
  chrome.webRequest.onBeforeRequest.emit({ tabId: -1, requestId: 'port-worker', url: 'http://worker.example:8080/', initiator: 'https://site.example:8443', type: 'xmlhttprequest' });
  chrome.webRequest.onResponseStarted.emit({ tabId: -1, requestId: 'port-worker', url: 'http://worker.example:8080/', ip: '2001:db8::1' });
  await controller.flush();
  const destinations = lastState(port).destinations;
  assert.deepEqual(destinations['host|site.example'].ports, [8443]);
  assert.deepEqual(destinations['host|site.example'].ips['192.0.2.10'].ports, [8443]);
  assert.deepEqual(destinations['host|socket.example'].ports, [9443, 443]);
  assert.deepEqual(destinations['host|worker.example'].ports, [8080]);
  assert.deepEqual(destinations['host|worker.example'].ips['2001:db8::1'].ports, [8080]);
});

test('late responses cannot cross a return to the same site, a clear, or a browser page', async () => {
  for (const transition of ['return', 'clear', 'browser']) {
    const chrome = fakeChrome();
    const controller = createBackgroundController(chrome, { now: () => 500 });
    await controller.ready;
    const port = fakePort();
    chrome.runtime.onConnect.emit(port);
    port.receive({ type: MSG.HELLO, tabId: 90 });
    navigate(chrome, 90, 'https://alpha.test/');
    const old = request(chrome, 90, 'https://cdn.vendor.test/old');
    if (transition === 'clear') port.receive({ type: MSG.CLEAR });
    else {
      chrome.tabs.onUpdated.emit(90, { url: transition === 'browser' ? 'chrome://settings/' : 'https://beta.test/' });
      navigate(chrome, 90, 'https://alpha.test/');
    }
    const fresh = request(chrome, 90, 'https://cdn.vendor.test/new');
    for (const [requestId, suffix, ip] of [[old, 'old', '203.0.113.10'], [fresh, 'new', '203.0.113.11']]) {
      chrome.webRequest.onResponseStarted.emit({ tabId: 90, url: `https://cdn.vendor.test/${suffix}`, requestId, ip });
    }
    await controller.flush();
    assert.deepEqual(Object.keys(controller.getState(90).destinations['host|cdn.vendor.test'].ips), ['203.0.113.11'], transition);
  }
});

test('worker responses respect each target tab record generation', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome, { now: () => 500 });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 91 });
  navigate(chrome, 91, 'https://app.alpha.test/');
  navigate(chrome, 92, 'https://app.alpha.test/');
  chrome.webRequest.onBeforeRequest.emit({ tabId: -1, initiator: 'https://app.alpha.test', url: 'https://cdn.vendor.test/old', requestId: 'shared-old', type: 'script' });
  port.receive({ type: MSG.CLEAR });
  request(chrome, 91, 'https://cdn.vendor.test/new');
  chrome.webRequest.onResponseStarted.emit({ tabId: -1, url: 'https://cdn.vendor.test/old', requestId: 'shared-old', ip: '203.0.113.10' });
  await controller.flush();
  assert.deepEqual(controller.getState(91).destinations['host|cdn.vendor.test'].ips, {});
  assert.ok(controller.getState(92).destinations['host|cdn.vendor.test'].ips['203.0.113.10']);
});

test('clear invalidates a checkpoint in every subscriber even when the clock does not move', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome, { now: () => 500 });
  await controller.ready;
  const first = fakePort();
  const second = fakePort();
  for (const port of [first, second]) {
    chrome.runtime.onConnect.emit(port);
    port.receive({ type: MSG.HELLO, tabId: 93 });
  }
  navigate(chrome, 93, 'https://alpha.test/');
  request(chrome, 93, 'https://cdn.vendor.test/old');
  await controller.flush();
  const checkpoint = captureCheckpoint(lastState(second));
  first.receive({ type: MSG.CLEAR });
  request(chrome, 93, 'https://cdn.vendor.test/new');
  await controller.flush();
  const next = lastState(second);
  assert.equal(next.recordGeneration, checkpoint.recordGeneration + 1);
  assert.equal(buildDestinationRows(next, { checkpoint }).length, 1);
});

test('registration failure keeps the previous settings and reports an error to all panels', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome, { logger: { warn() {} } });
  await controller.ready;
  const ports = [fakePort(), fakePort()];
  for (const port of ports) {
    chrome.runtime.onConnect.emit(port);
    port.receive({ type: MSG.HELLO, tabId: 94 });
  }
  await controller.flush();
  const unregister = chrome.scripting.unregisterContentScripts;
  chrome.scripting.unregisterContentScripts = async () => { throw new Error('registration failure'); };
  ports[0].receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();
  for (const port of ports) {
    assert.equal(port.sent.at(-1).settings.observePageApis, true);
    assert.equal(port.sent.at(-1).settingsError, 'apply');
  }
  assert.equal(chrome.localData.settings, undefined);
  chrome.scripting.unregisterContentScripts = unregister;
  ports[0].receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();
  assert.equal(ports[1].sent.at(-1).settings.observePageApis, false);
  assert.equal(ports[1].sent.at(-1).settingsError, null);
  assert.equal(chrome.localData.settings.observePageApis, false);
});

test('settings storage failure reports applied but unsaved settings and recovers on retry', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome, { logger: { warn() {} } });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 95 });
  await controller.flush();
  const save = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('storage failure'); };
  port.receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();
  assert.equal(port.sent.at(-1).settings.observePageApis, false);
  assert.equal(port.sent.at(-1).settingsError, 'save');
  assert.equal(chrome.localData.settings, undefined);
  chrome.storage.local.set = save;
  port.receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();
  assert.equal(port.sent.at(-1).settingsError, null);
  assert.equal(chrome.localData.settings.observePageApis, false);
});

test('startup registration failure is visible instead of silently claiming saved settings are active', async () => {
  const chrome = fakeChrome();
  chrome.scripting.registerContentScripts = async () => { throw new Error('registration failure'); };
  const controller = createBackgroundController(chrome, { logger: { warn() {} } });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 96 });
  await controller.flush();
  assert.equal(port.sent.at(-1).settingsError, 'apply');
});

test('delayed storage writes and checkpoints keep the exact snapshot they were given', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  navigate(chrome, 97, 'https://alpha.test/');
  request(chrome, 97, 'https://cdn.vendor.test/first');
  await controller.flush();
  const captured = controller.getState(97);
  const before = structuredClone(captured);
  const pending = [];
  chrome.storage.session.set = (values) => new Promise((resolve) => { pending.push({ values, resolve }); });
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 97 });
  request(chrome, 97, 'https://cdn.vendor.test/second');
  port.receive({ type: MSG.CHECKPOINT_REQUEST });
  request(chrome, 97, 'https://cdn.vendor.test/third');
  port.receive({ type: MSG.SET_PAUSED, paused: true });
  await waitFor(() => pending.length === 1, 'delayed persistence');
  const writeCount = pending[0].values['tab:97'].destinations['host|cdn.vendor.test'].count;
  port.receive({ type: MSG.SET_PAUSED, paused: false });
  request(chrome, 97, 'https://cdn.vendor.test/fourth');
  port.receive({ type: MSG.CHECKPOINT_REQUEST });
  await waitFor(() => lastMessage(port, MSG.CHECKPOINT_READY)?.state.destinations['host|cdn.vendor.test'].count === 4, 'fresh marker');
  assert.equal(pending[0].values['tab:97'].destinations['host|cdn.vendor.test'].count, writeCount);
  assert.deepEqual(captured, before);
  assert.equal(port.sent.find((message) => message.type === MSG.CHECKPOINT_READY).state.destinations['host|cdn.vendor.test'].count, 2);
  chrome.storage.session.set = async () => {};
  pending[0].resolve();
  await controller.flush();
});

test('a failed settings load leaves existing script registration untouched and reports the problem', async () => {
  const chrome = fakeChrome();
  chrome.storage.local.get = async () => { throw new Error('storage failure'); };
  const controller = createBackgroundController(chrome, { logger: { warn() {} } });
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 98 });
  await controller.flush();
  assert.deepEqual(chrome.scriptingCalls, []);
  assert.equal(port.sent.at(-1).settingsError, 'load');
  port.receive({ type: MSG.SET_OBSERVE_PAGE_APIS, enabled: false });
  await controller.flush();
  assert.equal(port.sent.at(-1).settingsError, null);
  assert.equal(chrome.localData.settings.observePageApis, false);
});

test('clearing while a document loads discards its buffered pre-clear IP', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 99 });
  navigate(chrome, 99, 'https://alpha.test/');
  chrome.webRequest.onBeforeRequest.emit({ tabId: 99, url: 'https://beta.test/', type: 'main_frame', requestId: 'pending-document' });
  chrome.webRequest.onResponseStarted.emit({ tabId: 99, url: 'https://beta.test/', ip: '203.0.113.10', requestId: 'pending-document' });
  port.receive({ type: MSG.CLEAR });
  chrome.tabs.onUpdated.emit(99, { url: 'https://beta.test/' });
  await controller.flush();
  assert.equal(controller.getState(99).siteKey, 'beta.test');
  assert.deepEqual(controller.getState(99).destinations, {});
});

test('requests started while paused cannot attach an IP after capture resumes', async () => {
  for (const worker of [false, true]) {
    const chrome = fakeChrome();
    const controller = createBackgroundController(chrome);
    await controller.ready;
    const port = fakePort();
    chrome.runtime.onConnect.emit(port);
    port.receive({ type: MSG.HELLO, tabId: 100 });
    navigate(chrome, 100, 'https://app.alpha.test/');
    request(chrome, 100, 'https://cdn.vendor.test/known');
    port.receive({ type: MSG.SET_PAUSED, paused: true });
    chrome.webRequest.onBeforeRequest.emit({
      tabId: worker ? -1 : 100, initiator: 'https://app.alpha.test',
      url: 'https://cdn.vendor.test/paused', type: 'script', requestId: 'paused-response'
    });
    port.receive({ type: MSG.SET_PAUSED, paused: false });
    chrome.webRequest.onResponseStarted.emit({
      tabId: worker ? -1 : 100, url: 'https://cdn.vendor.test/paused', requestId: 'paused-response', ip: '203.0.113.10'
    });
    await controller.flush();
    const destination = controller.getState(100).destinations['host|cdn.vendor.test'];
    assert.equal(destination.count, 1);
    assert.deepEqual(destination.ips, {});
  }
});

test('a document requested while paused follows navigation without retroactive capture on resume', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);
  port.receive({ type: MSG.HELLO, tabId: 101 });
  navigate(chrome, 101, 'https://alpha.test/');
  port.receive({ type: MSG.SET_PAUSED, paused: true });
  chrome.webRequest.onBeforeRequest.emit({ tabId: 101, url: 'https://beta.test/', type: 'main_frame', requestId: 'paused-document' });
  chrome.webRequest.onResponseStarted.emit({ tabId: 101, url: 'https://beta.test/', requestId: 'paused-document', ip: '203.0.113.10' });
  port.receive({ type: MSG.SET_PAUSED, paused: false });
  chrome.tabs.onUpdated.emit(101, { url: 'https://beta.test/' });
  await controller.flush();
  assert.equal(controller.getState(101).siteKey, 'beta.test');
  assert.deepEqual(controller.getState(101).destinations, {});
});


test('disabled observation removes both persisted page scripts on startup and keeps network capture', async () => {
  const chrome = fakeChrome({}, { settings: { observePageApis: false } }, [
    { id: 'domainscan-page-probe' }, { id: 'domainscan-signal-relay' }
  ]);
  const controller = createBackgroundController(chrome);
  await controller.ready;
  assert.deepEqual(await chrome.scripting.getRegisteredContentScripts(), []);
  assert.equal(chrome.scriptingCalls.some((entry) => entry.call === 'register'), false);
  navigate(chrome, 95, 'https://passive.example.com/');
  await controller.flush();
  assert.ok(Object.keys(controller.getState(95).destinations).length > 0);
});

test('startup upgrades a probe-only registration to a relay-first pair without removing other scripts', async () => {
  const chrome = fakeChrome({}, {}, [{ id: 'domainscan-page-probe' }, { id: 'unrelated' }]);
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const calls = chrome.scriptingCalls;
  assert.deepEqual(calls[0].ids, ['domainscan-page-probe']);
  assert.deepEqual(calls[1].scripts.map((script) => script.id), ['domainscan-signal-relay', 'domainscan-page-probe']);
  assert.equal((await chrome.scripting.getRegisteredContentScripts()).length, 3);
});
