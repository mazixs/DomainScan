import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MSG, PORT_NAME } from '../src/common/messages.js';
import { createBackgroundController } from '../src/background/controller.js';

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

function fakeChrome(initialStorage = {}) {
  const storage = structuredClone(initialStorage);
  const counters = { writes: 0 };
  return {
    storageData: storage,
    counters,
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
