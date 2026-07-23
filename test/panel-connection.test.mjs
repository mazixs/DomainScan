import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MSG, PORT_NAME } from '../src/common/messages.js';
import { createPanelConnection } from '../src/sidepanel/connection.js';

function fakeEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function fakePort() {
  return {
    name: PORT_NAME,
    onMessage: fakeEvent(),
    onDisconnect: fakeEvent(),
    sent: [],
    postMessage(message) {
      this.sent.push(structuredClone(message));
    }
  };
}

function fakeChrome(activeTabId = 1) {
  const ports = [];
  let currentTabId = activeTabId;
  return {
    ports,
    setActiveTab(tabId) {
      currentTabId = tabId;
      this.tabs.onActivated.emit({ tabId, windowId: 1 });
    },
    runtime: {
      connect(options) {
        assert.deepEqual(options, { name: PORT_NAME });
        const port = fakePort();
        ports.push(port);
        return port;
      }
    },
    tabs: {
      onActivated: fakeEvent(),
      async query(query) {
        assert.deepEqual(query, { active: true, currentWindow: true });
        return [{ id: currentTabId }];
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: fakeEvent()
    }
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test('connection binds on start and rebinds when the active tab changes', async () => {
  const chrome = fakeChrome(10);
  const states = [];
  const connection = createPanelConnection({
    chromeApi: chrome,
    onState: (state) => states.push(state)
  });
  await settle();

  assert.deepEqual(chrome.ports[0].sent, [{ type: MSG.HELLO, tabId: 10 }]);

  chrome.setActiveTab(11);
  await settle();
  assert.deepEqual(chrome.ports[0].sent.at(-1), { type: MSG.HELLO, tabId: 11 });

  chrome.ports[0].onMessage.emit({ type: MSG.STATE, state: { tabId: 11 } });
  chrome.ports[0].onMessage.emit({ type: MSG.STATE, state: { tabId: 11, updatedAt: 2 } });
  assert.deepEqual(states, [{ tabId: 11 }, { tabId: 11, updatedAt: 2 }]);
  connection.stop();
});

test('disconnect schedules bounded reconnection and rebinds the current tab', async () => {
  const chrome = fakeChrome(20);
  const timers = [];
  const statuses = [];
  const connection = createPanelConnection({
    chromeApi: chrome,
    onState() {},
    onConnectionChange: (status) => statuses.push(status),
    setTimeoutFn(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutFn() {}
  });
  await settle();

  chrome.ports[0].onDisconnect.emit();
  assert.equal(timers[0].delay, 250);
  assert.equal(statuses.at(-1), 'disconnected');

  chrome.setActiveTab(21);
  timers[0].callback();
  await settle();
  assert.equal(chrome.ports.length, 2);
  assert.deepEqual(chrome.ports[1].sent.at(-1), { type: MSG.HELLO, tabId: 21 });
  connection.stop();
});

test('focus changes trigger active-tab rebinding except for no focused window', async () => {
  const chrome = fakeChrome(30);
  const connection = createPanelConnection({ chromeApi: chrome, onState() {} });
  await settle();

  chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  await settle();
  assert.equal(chrome.ports[0].sent.length, 1);

  chrome.windows.onFocusChanged.emit(1);
  await settle();
  assert.equal(chrome.ports[0].sent.length, 2);
  connection.stop();
});

test('an older active-tab query cannot overwrite a newer binding or receive controls', async () => {
  const chrome = fakeChrome(1);
  const pending = [];
  chrome.tabs.query = () => new Promise((resolve) => pending.push(resolve));
  const statuses = [];
  const connection = createPanelConnection({
    chromeApi: chrome,
    onState() {},
    onConnectionChange: (status) => statuses.push(status)
  });
  await settle();

  chrome.tabs.onActivated.emit({ tabId: 2, windowId: 1 });
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(connection.post({ type: MSG.CLEAR }), false);

  pending[1]([{ id: 2 }]);
  await settle();
  assert.deepEqual(chrome.ports[0].sent, [{ type: MSG.HELLO, tabId: 2 }]);

  pending[0]([{ id: 1 }]);
  await settle();
  assert.deepEqual(chrome.ports[0].sent, [{ type: MSG.HELLO, tabId: 2 }]);
  assert.equal(connection.post({ type: MSG.CLEAR }), false);

  chrome.ports[0].onMessage.emit({ type: MSG.STATE, state: { tabId: 2 } });
  assert.equal(statuses.at(-1), 'connected');
  assert.equal(connection.post({ type: MSG.CLEAR }), true);
  assert.deepEqual(chrome.ports[0].sent.at(-1), { type: MSG.CLEAR });
  connection.stop();
});
