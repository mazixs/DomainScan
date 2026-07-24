import {
  isIpLiteral,
  normalizeHostname,
  normalizeIpLiteral,
  siteKeyForHost
} from './domain.js';
import { isFingerprintSignal } from './fingerprint.js';

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

  const rawPageHost = normalizeHostname(parsed.hostname);
  const pageHost = normalizeIpLiteral(rawPageHost) || rawPageHost;
  if (!pageHost) return state;

  const siteKey = siteKeyForHost(pageHost);
  const previousSiteKey = state.siteKey ||
    (state.pageHost ? siteKeyForHost(state.pageHost) : null);
  const changedSite = !!previousSiteKey && previousSiteKey !== siteKey;

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
  const rawValue = normalizeHostname(observation && observation.value);
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
  const rawValue = normalizeHostname(host);
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

export function recordFingerprintSignal(state, signal, frameId, now = Date.now()) {
  if (!isFingerprintSignal(signal)) return state;

  const signals = state.fingerprint && state.fingerprint.signals
    ? state.fingerprint.signals
    : {};
  const existing = signals[signal];
  const normalizedFrameId = Number.isInteger(frameId) ? frameId : 0;
  const frameIds = existing && Array.isArray(existing.frameIds)
    ? existing.frameIds
    : [];
  const nextFrameIds = frameIds.includes(normalizedFrameId)
    ? frameIds
    : [...frameIds, normalizedFrameId].sort((a, b) => a - b);

  const record = existing
    ? {
        ...existing,
        lastSeen: now,
        count: existing.count + 1,
        frameIds: nextFrameIds
      }
    : {
        key: signal,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        frameIds: nextFrameIds
      };

  return {
    ...state,
    fingerprint: {
      signals: {
        ...signals,
        [signal]: record
      }
    },
    updatedAt: now
  };
}

function originFromUrl(value) {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch (_error) {
    return null;
  }
}

function normalizeIpHistory(destination) {
  const ips = {};
  for (const source of Object.values(destination.ips || {})) {
    const value = normalizeIpLiteral(source && source.value);
    if (!value) continue;
    ips[value] = {
      value,
      firstSeen: Number.isFinite(source.firstSeen) ? source.firstSeen : destination.firstSeen,
      lastSeen: Number.isFinite(source.lastSeen) ? source.lastSeen : destination.lastSeen,
      count: Number.isFinite(source.count) && source.count > 0 ? source.count : 1
    };
  }

  const legacyIp = normalizeIpLiteral(destination.ip);
  if (legacyIp && !ips[legacyIp]) {
    ips[legacyIp] = {
      value: legacyIp,
      firstSeen: destination.firstSeen,
      lastSeen: destination.lastSeen,
      count: 1
    };
  }
  return ips;
}

function normalizeFingerprint(value, fallbackTime) {
  const signals = {};
  for (const [key, source] of Object.entries((value && value.signals) || {})) {
    if (!isFingerprintSignal(key) || !source) continue;
    signals[key] = {
      key,
      firstSeen: Number.isFinite(source.firstSeen) ? source.firstSeen : fallbackTime,
      lastSeen: Number.isFinite(source.lastSeen) ? source.lastSeen : fallbackTime,
      count: Number.isFinite(source.count) && source.count > 0 ? source.count : 1,
      frameIds: Array.isArray(source.frameIds)
        ? [...new Set(source.frameIds.filter(Number.isInteger))].sort((a, b) => a - b)
        : [0]
    };
  }

  const legacy = [
    ['canvas', 'canvas_readback'],
    ['webgl', 'webgl_renderer'],
    ['audio', 'audio_readback']
  ];
  for (const [legacyKey, signalKey] of legacy) {
    if (!value || !value[legacyKey] || signals[signalKey]) continue;
    const time = Number.isFinite(value.firstSeen) ? value.firstSeen : fallbackTime;
    signals[signalKey] = {
      key: signalKey,
      firstSeen: time,
      lastSeen: time,
      count: 1,
      frameIds: [0]
    };
  }
  return { signals };
}

/** Coerce persisted or legacy data into the current TabState schema. */
export function normalizeTabState(value, now = Date.now()) {
  const source = value && typeof value === 'object' ? value : {};
  const tabId = Number.isInteger(source.tabId) ? source.tabId : -1;
  const rawPageHost = normalizeHostname(source.pageHost);
  const pageHost = normalizeIpLiteral(rawPageHost) || rawPageHost || null;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : now;
  const destinations = {};

  for (const candidate of Object.values(source.destinations || {})) {
    if (!candidate || typeof candidate !== 'object') continue;
    const rawValue = normalizeHostname(candidate.value);
    if (!rawValue) continue;
    const normalizedIp = normalizeIpLiteral(rawValue);
    const value = normalizedIp || rawValue;
    const kind = candidate.kind === 'ip' || normalizedIp ? 'ip' : 'host';
    const id = `${kind}|${value}`;
    destinations[id] = {
      id,
      kind,
      value,
      party: kind === 'ip' ? 'ip' : candidate.party || 'third',
      requestType: candidate.requestType || 'other',
      transport: candidate.transport || 'other',
      ips: kind === 'host' ? normalizeIpHistory(candidate) : {},
      firstSeen: Number.isFinite(candidate.firstSeen) ? candidate.firstSeen : updatedAt,
      lastSeen: Number.isFinite(candidate.lastSeen) ? candidate.lastSeen : updatedAt,
      count: Number.isFinite(candidate.count) && candidate.count > 0 ? candidate.count : 1
    };
  }

  return {
    tabId,
    siteKey: source.siteKey || (pageHost ? siteKeyForHost(pageHost) : null),
    pageUrl: originFromUrl(source.pageUrl),
    pageHost,
    destinations,
    fingerprint: normalizeFingerprint(source.fingerprint, updatedAt),
    paused: !!source.paused,
    updatedAt
  };
}
