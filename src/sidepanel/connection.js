import { PORT_NAME, MSG } from '../common/messages.js';

export function createPanelConnection({
  chromeApi,
  onState,
  onConnectionChange = () => {},
  onError = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  let port = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let bindGeneration = 0;
  let binding = false;
  let pendingTabId = null;
  let boundTabId = null;

  async function bindActiveTab() {
    if (stopped || !port) return;
    const generation = ++bindGeneration;
    binding = true;
    pendingTabId = null;
    onConnectionChange('binding');
    try {
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs && tabs[0] && tabs[0].id;
      if (generation !== bindGeneration || stopped || !port) return;
      if (!Number.isInteger(tabId)) {
        binding = false;
        onConnectionChange('disconnected');
        return;
      }
      pendingTabId = tabId;
      port.postMessage({ type: MSG.HELLO, tabId });
    } catch (error) {
      if (generation !== bindGeneration) return;
      binding = false;
      onError(error);
      onConnectionChange('disconnected');
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer != null) return;
    const delay = Math.min(250 * (2 ** reconnectAttempt), 4000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped || port) return;
    onConnectionChange('connecting');
    try {
      const connectedPort = chromeApi.runtime.connect({ name: PORT_NAME });
      port = connectedPort;

      connectedPort.onMessage.addListener((message) => {
        if (message && message.type === MSG.STATE) {
          const tabId = message.state && message.state.tabId;
          if (!Number.isInteger(tabId)) return;
          if (pendingTabId != null) {
            if (tabId !== pendingTabId) return;
            reconnectAttempt = 0;
            binding = false;
            boundTabId = tabId;
            pendingTabId = null;
            onConnectionChange('connected');
          } else if (tabId !== boundTabId) {
            return;
          }
          onState(message.state, message.settings);
        }
      });
      connectedPort.onDisconnect.addListener(() => {
        if (port !== connectedPort) return;
        bindGeneration += 1;
        binding = false;
        boundTabId = null;
        pendingTabId = null;
        port = null;
        onConnectionChange('disconnected');
        scheduleReconnect();
      });
      bindActiveTab();
    } catch (error) {
      port = null;
      onError(error);
      onConnectionChange('disconnected');
      scheduleReconnect();
    }
  }

  function onTabActivated() {
    bindActiveTab();
  }

  function onWindowFocusChanged(windowId) {
    if (windowId === chromeApi.windows.WINDOW_ID_NONE) return;
    bindActiveTab();
  }

  chromeApi.tabs.onActivated.addListener(onTabActivated);
  chromeApi.windows.onFocusChanged.addListener(onWindowFocusChanged);
  connect();

  return {
    post(message) {
      if (!port || binding || pendingTabId != null || boundTabId == null) return false;
      try {
        port.postMessage(message);
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },
    rebind: bindActiveTab,
    stop() {
      stopped = true;
      bindGeneration += 1;
      if (reconnectTimer != null) clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
      chromeApi.tabs.onActivated.removeListener(onTabActivated);
      chromeApi.windows.onFocusChanged.removeListener(onWindowFocusChanged);
      binding = false;
      boundTabId = null;
      pendingTabId = null;
      port = null;
    }
  };
}
