import { isIpLiteral, normalizeIpLiteral, siteKeyForHost } from './domain.js';

function normalizeHost(value) {
  let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}

export function makeTabState(tabId, now = Date.now()) {
  return {
    tabId,
    siteKey: null,
    pageUrl: null,
    pageHost: null,
    destinations: {},
    fingerprint: { signals: {} },
    paused: false,
    updatedAt: now
  };
}

export function applyTopLevelNavigation(state, url, now = Date.now()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return state;
  }

  const rawPageHost = normalizeHost(parsed.hostname);
  const pageHost = normalizeIpLiteral(rawPageHost) || rawPageHost;
  if (!pageHost) return state;

  const siteKey = siteKeyForHost(pageHost);
  const changedSite = !!state.siteKey && state.siteKey !== siteKey;

  return {
    ...state,
    siteKey,
    pageUrl: parsed.origin,
    pageHost,
    destinations: changedSite ? {} : state.destinations,
    fingerprint: changedSite ? { signals: {} } : state.fingerprint,
    updatedAt: now
  };
}

export function recordDestination(state, observation, now = Date.now()) {
  const rawValue = normalizeHost(observation && observation.value);
  if (!rawValue) return state;
  const value = normalizeIpLiteral(rawValue) || rawValue;

  const kind = observation.kind || (isIpLiteral(value) ? 'ip' : 'host');
  const id = `${kind}|${value}`;
  const existing = state.destinations[id];
  const destination = existing
    ? {
        ...existing,
        lastSeen: now,
        count: existing.count + 1
      }
    : {
        id,
        kind,
        value,
        party: observation.party,
        requestType: observation.requestType,
        transport: observation.transport,
        ips: {},
        firstSeen: now,
        lastSeen: now,
        count: 1
      };

  return {
    ...state,
    destinations: {
      ...state.destinations,
      [id]: destination
    },
    updatedAt: now
  };
}

export function recordResolvedIp(state, host, ip, now = Date.now()) {
  const rawValue = normalizeHost(host);
  const value = normalizeIpLiteral(rawValue) || rawValue;
  const normalizedIp = normalizeIpLiteral(ip);
  if (!value || !normalizedIp) return state;

  const id = `${isIpLiteral(value) ? 'ip' : 'host'}|${value}`;
  const destination = state.destinations[id];
  if (!destination || destination.kind !== 'host') return state;

  const existing = destination.ips && destination.ips[normalizedIp];
  const address = existing
    ? {
        ...existing,
        lastSeen: now,
        count: existing.count + 1
      }
    : {
        value: normalizedIp,
        firstSeen: now,
        lastSeen: now,
        count: 1
      };

  return {
    ...state,
    destinations: {
      ...state.destinations,
      [id]: {
        ...destination,
        ips: {
          ...(destination.ips || {}),
          [normalizedIp]: address
        },
        lastSeen: now
      }
    },
    updatedAt: now
  };
}
