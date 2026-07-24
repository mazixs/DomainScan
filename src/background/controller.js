import { PORT_NAME, MSG, STORAGE_PREFIX, tabKey } from '../common/messages.js';
import {
  classifyParty,
  isIpLiteral,
  normalizeHostname,
  siteKeyForHost
} from '../lib/domain.js';
import {
  applyTopLevelNavigation,
  makeTabState,
  normalizeTabState,
  recordDestination,
  recordFingerprintSignal,
  recordResolvedIp
} from '../lib/tab-state.js';

function transportFromUrl(parsed) {
  switch (parsed.protocol) {
    case 'https:': return 'https';
    case 'http:': return 'http';
    case 'wss:': return 'wss';
    case 'ws:': return 'ws';
    default: return 'other';
  }
}

function mapRequestType(type) {
  switch (type) {
    case 'main_frame':
    case 'sub_frame': return 'document';
    case 'image': return 'image';
    case 'script': return 'script';
    case 'stylesheet': return 'style';
    case 'xmlhttprequest': return 'fetch';
    case 'ping':
    case 'csp_report': return 'beacon';
    case 'media': return 'media';
    case 'font': return 'font';
    case 'websocket': return 'websocket';
    default: return 'other';
  }
}

function isIgnorableRequest(tabId, parsed) {
  return !Number.isInteger(tabId) ||
    tabId < 0 ||
    parsed.protocol === 'chrome-extension:';
}

function legacySignal(message) {
  if (typeof message.signal === 'string') return message.signal;
  const legacy = message.signals || {};
  if (legacy.canvas) return 'canvas_readback';
  if (legacy.webgl) return 'webgl_renderer';
  if (legacy.audio) return 'audio_readback';
  return null;
}

export function createBackgroundController(
  chromeApi,
  { now = () => Date.now(), logger = console } = {}
) {
  const tabs = new Map();
  const portBindings = new Map();
  const subscribers = new Map();
  const persistence = new Map();
  const requestSites = new Map();
  const currentDocuments = new Map();

  function diagnose(operation, error, tabId) {
    try {
      logger.warn('[DomainScan]', operation, {
        tabId: Number.isInteger(tabId) ? tabId : undefined,
        message: error instanceof Error ? error.message : String(error)
      });
    } catch (_error) {
      // Diagnostics must never affect extension behavior.
    }
  }

  const ready = chromeApi.storage.session.get(null)
    .then((stored) => {
      for (const [key, value] of Object.entries(stored || {})) {
        if (!key.startsWith(STORAGE_PREFIX)) continue;
        const state = normalizeTabState(value, now());
        if (state.tabId >= 0) tabs.set(state.tabId, state);
      }
    })
    .catch((error) => diagnose('storage.session.get', error));

  let work = ready;
  function enqueue(operation, task) {
    work = work
      .then(task)
      .catch((error) => diagnose(operation, error));
    return work;
  }

  function getOrCreate(tabId) {
    let state = tabs.get(tabId);
    if (!state) {
      state = makeTabState(tabId, now());
      tabs.set(tabId, state);
    }
    return state;
  }

  function persist(state) {
    const previous = persistence.get(state.tabId) || Promise.resolve();
    const next = previous
      .then(() => chromeApi.storage.session.set({ [tabKey(state.tabId)]: state }))
      .catch((error) => diagnose('storage.session.set', error, state.tabId));
    persistence.set(state.tabId, next);
  }

  function pushState(tabId) {
    const state = tabs.get(tabId);
    if (!state) return;
    for (const port of subscribers.get(tabId) || []) {
      try {
        port.postMessage({ type: MSG.STATE, state });
      } catch (error) {
        diagnose('port.postMessage', error, tabId);
      }
    }
  }

  function commit(state) {
    tabs.set(state.tabId, state);
    pushState(state.tabId);
    persist(state);
  }

  function unbindPort(port) {
    const oldTabId = portBindings.get(port);
    if (oldTabId == null) return;
    const ports = subscribers.get(oldTabId);
    if (ports) {
      ports.delete(port);
      if (ports.size === 0) subscribers.delete(oldTabId);
    }
    portBindings.delete(port);
  }

  function bindPort(port, tabId) {
    unbindPort(port);
    portBindings.set(port, tabId);
    let ports = subscribers.get(tabId);
    if (!ports) {
      ports = new Set();
      subscribers.set(tabId, ports);
    }
    ports.add(port);
    port.postMessage({ type: MSG.STATE, state: getOrCreate(tabId) });
  }

  function onBeforeRequest(details) {
    const { tabId, url, type, requestId, documentId } = details || {};
    if (!url) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;

    let state = getOrCreate(tabId);
    if (type === 'main_frame') {
      state = applyTopLevelNavigation(state, url, now());
      currentDocuments.set(tabId, {
        siteKey: state.siteKey,
        ids: new Set(typeof documentId === 'string' ? [documentId] : [])
      });
    } else if (type === 'sub_frame' && typeof documentId === 'string') {
      const documents = currentDocuments.get(tabId);
      if (documents && documents.siteKey === state.siteKey) {
        documents.ids.add(documentId);
      }
    }
    if (typeof requestId === 'string') {
      requestSites.set(requestId, {
        tabId,
        siteKey: state.siteKey,
        host: normalizeHostname(parsed.hostname)
      });
    }
    if (state.paused) {
      if (type === 'main_frame') commit(state);
      return;
    }

    state = recordDestination(state, {
      value: parsed.hostname,
      kind: isIpLiteral(parsed.hostname) ? 'ip' : 'host',
      party: classifyParty(parsed.hostname, state.pageHost),
      requestType: mapRequestType(type),
      transport: transportFromUrl(parsed)
    }, now());
    commit(state);
  }

  function onResponseStarted(details) {
    const { tabId, url, ip, requestId } = details || {};
    if (!url || !ip) return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      return;
    }
    if (isIgnorableRequest(tabId, parsed)) return;
    const requestSite = typeof requestId === 'string' ? requestSites.get(requestId) : null;
    if (typeof requestId === 'string') requestSites.delete(requestId);
    if (!requestSite ||
        requestSite.tabId !== tabId ||
        requestSite.host !== normalizeHostname(parsed.hostname)) {
      return;
    }
    const state = tabs.get(tabId);
    if (!state || state.paused || state.siteKey !== requestSite.siteKey) return;
    const next = recordResolvedIp(state, parsed.hostname, ip, now());
    if (next !== state) commit(next);
  }

  chromeApi.webRequest.onBeforeRequest.addListener(
    (details) => enqueue('webRequest.onBeforeRequest', () => onBeforeRequest(details)),
    { urls: ['<all_urls>'] }
  );
  chromeApi.webRequest.onResponseStarted.addListener(
    (details) => enqueue('webRequest.onResponseStarted', () => onResponseStarted(details)),
    { urls: ['<all_urls>'] }
  );
  const forgetRequest = (operation, details) => {
    enqueue(operation, () => {
      if (details && typeof details.requestId === 'string') {
        requestSites.delete(details.requestId);
      }
    });
  };
  chromeApi.webRequest.onCompleted.addListener(
    (details) => forgetRequest('webRequest.onCompleted', details),
    { urls: ['<all_urls>'] }
  );
  chromeApi.webRequest.onErrorOccurred.addListener(
    (details) => forgetRequest('webRequest.onErrorOccurred', details),
    { urls: ['<all_urls>'] }
  );

  chromeApi.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== PORT_NAME) return;

    port.onMessage.addListener((message) => {
      enqueue('port.onMessage', () => {
        if (!message || typeof message !== 'object') return;
        if (message.type === MSG.HELLO && Number.isInteger(message.tabId)) {
          bindPort(port, message.tabId);
          return;
        }

        const tabId = portBindings.get(port);
        if (tabId == null) return;
        const state = getOrCreate(tabId);
        if (message.type === MSG.SET_PAUSED) {
          commit({ ...state, paused: !!message.paused, updatedAt: now() });
        } else if (message.type === MSG.CLEAR) {
          commit({
            ...state,
            destinations: {},
            fingerprint: { signals: {} },
            updatedAt: now()
          });
        }
      });
    });

    port.onDisconnect.addListener(() => unbindPort(port));
  });

  chromeApi.runtime.onMessage.addListener((message, sender) => {
    enqueue('runtime.onMessage', () => {
      if (!message || message.type !== MSG.FINGERPRINT) return;
      const tabId = sender && sender.tab && sender.tab.id;
      if (!Number.isInteger(tabId) || tabId < 0) return;
      const state = getOrCreate(tabId);
      if (state.paused) return;
      const documents = currentDocuments.get(tabId);
      if (documents && typeof sender.documentId === 'string' && documents.ids.size > 0) {
        if (documents.siteKey !== state.siteKey || !documents.ids.has(sender.documentId)) return;
      } else {
        const observedHost = normalizeHostname(message.pageHost);
        if (observedHost && siteKeyForHost(observedHost) !== state.siteKey) return;
        if (!observedHost && sender.frameId === 0 && sender.url) {
          try {
            if (siteKeyForHost(new URL(sender.url).hostname) !== state.siteKey) return;
          } catch (_error) {
            return;
          }
        }
      }
      const next = recordFingerprintSignal(
        state,
        legacySignal(message),
        sender.frameId,
        now()
      );
      if (next !== state) commit(next);
    });
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    enqueue('tabs.onRemoved', async () => {
      tabs.delete(tabId);
      currentDocuments.delete(tabId);
      for (const [requestId, requestSite] of requestSites) {
        if (requestSite.tabId === tabId) requestSites.delete(requestId);
      }
      const ports = subscribers.get(tabId);
      if (ports) {
        for (const port of ports) portBindings.delete(port);
        subscribers.delete(tabId);
      }
      const pendingWrite = persistence.get(tabId);
      if (pendingWrite) await pendingWrite;
      await chromeApi.storage.session.remove(tabKey(tabId));
      persistence.delete(tabId);
    });
  });

  function enableSidePanelOnActionClick() {
    return chromeApi.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => diagnose('sidePanel.setPanelBehavior', error));
  }

  chromeApi.runtime.onInstalled.addListener(enableSidePanelOnActionClick);
  chromeApi.runtime.onStartup.addListener(enableSidePanelOnActionClick);
  enableSidePanelOnActionClick();

  return {
    ready,
    getState(tabId) {
      return tabs.get(tabId);
    },
    async flush() {
      await work;
      await Promise.all([...persistence.values()]);
    }
  };
}
