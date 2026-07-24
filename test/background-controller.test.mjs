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
  return {
    storageData: storage,
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
      onRemoved: fakeEvent()
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

test('a panel port can rebind between tabs without receiving stale tab updates', async () => {
  const chrome = fakeChrome();
  const controller = createBackgroundController(chrome);
  await controller.ready;
  const port = fakePort();
  chrome.runtime.onConnect.emit(port);

  port.receive({ type: MSG.HELLO, tabId: 11 });
  await controller.flush();
  assert.equal(lastState(port).tabId, 11);

  request(chrome, 11, 'https://one.alpha.test/', 'main_frame');
  await controller.flush();
  assert.equal(lastState(port).pageHost, 'one.alpha.test');

  port.receive({ type: MSG.HELLO, tabId: 12 });
  await controller.flush();
  const sentAfterRebind = port.sent.length;
  request(chrome, 11, 'https://cdn.alpha.test/a.js');
  await controller.flush();
  assert.equal(port.sent.length, sentAfterRebind);

  request(chrome, 12, 'https://one.beta.test/', 'main_frame');
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
  request(chrome, 3, 'https://example.com/', 'main_frame');
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

  request(chrome, 5, 'https://one.alpha.test/a', 'main_frame');
  request(chrome, 5, 'https://cdn.alpha.test/a.js');
  request(chrome, 5, 'https://two.alpha.test/b', 'main_frame');
  await controller.flush();
  assert.ok(lastState(port).destinations['host|cdn.alpha.test']);

  request(chrome, 5, 'https://one.beta.test/', 'main_frame');
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
  request(chrome, 8, 'https://one.alpha.test/', 'main_frame');
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

  request(chrome, 8, 'https://one.beta.test/', 'main_frame');
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
  request(chrome, 2, 'https://one.alpha.test/', 'main_frame');
  const oldRequestId = request(chrome, 2, 'https://cdn.shared.test/old.js');
  request(chrome, 2, 'https://one.beta.test/', 'main_frame');
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

  chrome.webRequest.onBeforeRequest.emit({
    tabId: 19,
    url: 'https://one.alpha.test/',
    type: 'main_frame',
    requestId: 'navigation-old',
    documentId: 'document-old'
  });
  chrome.webRequest.onBeforeRequest.emit({
    tabId: 19,
    url: 'https://one.beta.test/',
    type: 'main_frame',
    requestId: 'navigation-new',
    documentId: 'document-new'
  });
  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'timezone', pageHost: 'one.alpha.test' },
    { tab: { id: 19, url: 'https://one.beta.test/' }, frameId: 0, documentId: 'document-old' }
  );
  await controller.flush();
  assert.deepEqual(controller.getState(19).fingerprint.signals, {});

  chrome.runtime.onMessage.emit(
    { type: MSG.FINGERPRINT, signal: 'language', pageHost: 'one.beta.test' },
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
  request(chrome, 6, 'https://example.com/', 'main_frame');
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
  request(chrome, 17, 'https://example.com/', 'main_frame');
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
