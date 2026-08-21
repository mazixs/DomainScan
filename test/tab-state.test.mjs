import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeTabState,
  applyTopLevelNavigation,
  recordDestination,
  recordResolvedIp,
  recordFingerprintSignal,
  normalizeTabState
} from '../src/lib/tab-state.js';

function hostObservation(value, requestType = 'script') {
  return {
    value,
    kind: 'host',
    party: 'third',
    requestType,
    transport: 'https'
  };
}

test('same registrable domain preserves accumulated destinations across paths and subdomains', () => {
  let state = makeTabState(7, 100);
  state = applyTopLevelNavigation(state, 'https://news.example.com/article?id=secret', 101);
  state = recordDestination(state, hostObservation('cdn.vendor.test'), 102);
  state = applyTopLevelNavigation(state, 'https://mail.example.com/inbox#private', 103);

  assert.equal(state.siteKey, 'example.com');
  assert.equal(state.pageHost, 'mail.example.com');
  assert.equal(state.pageUrl, 'https://mail.example.com');
  assert.ok(state.destinations['host|cdn.vendor.test']);
});

test('different registrable domain starts a fresh site session in the same tab', () => {
  let state = makeTabState(7, 100);
  state = applyTopLevelNavigation(state, 'https://news.example.com/', 101);
  state = recordDestination(state, hostObservation('cdn.vendor.test'), 102);
  state = { ...state, paused: true, fingerprint: { signals: { timezone: { count: 1 } } } };

  state = applyTopLevelNavigation(state, 'https://www.google.test/search', 103);

  assert.equal(state.siteKey, 'google.test');
  assert.deepEqual(state.destinations, {});
  assert.deepEqual(state.fingerprint, { signals: {} });
  assert.equal(state.paused, true);
});

test('navigation derives a missing legacy site key before deciding whether to preserve evidence', () => {
  let state = makeTabState(7, 100);
  state = {
    ...state,
    siteKey: null,
    pageHost: 'old.example.com',
    destinations: {
      'host|old.example.com': {
        id: 'host|old.example.com',
        kind: 'host',
        value: 'old.example.com'
      }
    }
  };

  state = applyTopLevelNavigation(state, 'https://new.example.net/', 101);
  assert.equal(state.siteKey, 'example.net');
  assert.deepEqual(state.destinations, {});
});

test('each tab starts with independent destination storage', () => {
  let first = makeTabState(1, 100);
  const second = makeTabState(2, 100);
  first = recordDestination(first, hostObservation('one.example'), 101);

  assert.ok(first.destinations['host|one.example']);
  assert.deepEqual(second.destinations, {});
});

test('resolved IP history retains unique addresses and occurrence counts', () => {
  let state = makeTabState(4, 100);
  state = applyTopLevelNavigation(state, 'https://example.com/', 101);
  state = recordDestination(state, hostObservation('cdn.example.com'), 102);
  state = recordResolvedIp(state, 'cdn.example.com', '203.0.113.10', 103);
  state = recordResolvedIp(state, 'cdn.example.com', '203.0.113.11', 104);
  state = recordResolvedIp(state, 'cdn.example.com', '203.0.113.10', 105);

  const ips = state.destinations['host|cdn.example.com'].ips;
  assert.deepEqual(Object.keys(ips), ['203.0.113.10', '203.0.113.11']);
  assert.deepEqual(ips['203.0.113.10'], {
    value: '203.0.113.10',
    firstSeen: 103,
    lastSeen: 105,
    count: 2
  });
});

test('resolved IP history deduplicates equivalent IPv6 spellings', () => {
  let state = makeTabState(4, 100);
  state = recordDestination(state, hostObservation('cdn.example.com'), 101);
  state = recordResolvedIp(state, 'cdn.example.com', '2001:0DB8:0:0:0:0:0:1', 102);
  state = recordResolvedIp(state, 'cdn.example.com', '2001:db8::1', 103);

  const ips = state.destinations['host|cdn.example.com'].ips;
  assert.deepEqual(Object.keys(ips), ['2001:db8::1']);
  assert.equal(ips['2001:db8::1'].count, 2);
});

test('destination history deduplicates Unicode and Punycode host spellings', () => {
  let state = makeTabState(4, 100);
  state = recordDestination(state, hostObservation('bücher.example'), 101);
  state = recordDestination(state, hostObservation('xn--bcher-kva.example'), 102);

  assert.deepEqual(Object.keys(state.destinations), ['host|xn--bcher-kva.example']);
  assert.equal(state.destinations['host|xn--bcher-kva.example'].count, 2);
});

test('invalid resolved IP values are ignored', () => {
  let state = makeTabState(4, 100);
  state = recordDestination(state, hostObservation('cdn.example.com'), 101);
  const unchanged = recordResolvedIp(state, 'cdn.example.com', 'not:an:ip', 102);

  assert.deepEqual(unchanged, state);
});

test('direct IP navigation uses the normalized IP as the site key', () => {
  let state = makeTabState(9, 100);
  state = applyTopLevelNavigation(state, 'https://[2001:db8::1]/status', 101);

  assert.equal(state.siteKey, '2001:db8::1');
  assert.equal(state.pageHost, '2001:db8::1');
});

test('fingerprint signal history retains counts, timestamps, and unique frame IDs', () => {
  let state = makeTabState(9, 100);
  state = recordFingerprintSignal(state, 'timezone', 0, 101);
  state = recordFingerprintSignal(state, 'timezone', 7, 102);
  state = recordFingerprintSignal(state, 'timezone', 0, 103);

  assert.deepEqual(state.fingerprint.signals.timezone, {
    key: 'timezone',
    firstSeen: 101,
    lastSeen: 103,
    count: 3,
    frameIds: [0, 7]
  });
});

test('unknown fingerprint signals are ignored', () => {
  const state = makeTabState(9, 100);
  assert.equal(recordFingerprintSignal(state, 'invented', 0, 101), state);
});

test('normalizeTabState migrates the MVP storage shape without losing evidence', () => {
  const state = normalizeTabState({
    tabId: 5,
    pageUrl: 'https://news.example.com/private?token=secret',
    pageHost: 'news.example.com',
    destinations: {
      'host|cdn.example.com': {
        id: 'host|cdn.example.com',
        kind: 'host',
        value: 'cdn.example.com',
        party: 'first',
        requestType: 'script',
        transport: 'https',
        ip: '203.0.113.7',
        firstSeen: 10,
        lastSeen: 20,
        count: 2
      }
    },
    fingerprint: {
      canvas: true,
      webgl: true,
      audio: false,
      firstSeen: 12
    },
    paused: true,
    updatedAt: 20
  }, 30);

  assert.equal(state.siteKey, 'example.com');
  assert.equal(state.pageUrl, 'https://news.example.com');
  assert.deepEqual(Object.keys(state.destinations['host|cdn.example.com'].ips), ['203.0.113.7']);
  assert.deepEqual(Object.keys(state.fingerprint.signals), [
    'canvas_readback',
    'webgl_renderer'
  ]);
  assert.equal(state.paused, true);
});

test('evidence gathered before the site was known is dropped once it is known', () => {
  let state = makeTabState(1, 1000);
  state = recordDestination(state, {
    value: 'tracker.alpha.test',
    kind: 'host',
    party: 'third',
    requestType: 'script',
    transport: 'https'
  }, 1000);
  state = recordFingerprintSignal(state, 'timezone', 0, 1000);

  state = applyTopLevelNavigation(state, 'https://one.beta.test/', 2000);

  assert.equal(state.siteKey, 'beta.test');
  assert.deepEqual(state.destinations, {});
  assert.deepEqual(state.fingerprint.signals, {});
});

test('an empty tab keeps its record start when the first site becomes known', () => {
  const created = makeTabState(1, 1000);
  const navigated = applyTopLevelNavigation(created, 'https://one.alpha.test/', 2000);

  assert.equal(created.siteStartedAt, 1000);
  assert.equal(navigated.siteStartedAt, 1000);
});

test('the record start moves to the moment a new site session begins', () => {
  let state = applyTopLevelNavigation(makeTabState(1, 1000), 'https://one.alpha.test/', 2000);
  state = applyTopLevelNavigation(state, 'https://two.alpha.test/', 3000);
  assert.equal(state.siteStartedAt, 1000, 'the same site keeps the original start');

  state = applyTopLevelNavigation(state, 'https://one.beta.test/', 4000);
  assert.equal(state.siteStartedAt, 4000);
});

test('a persisted record without a start time gets one', () => {
  const state = normalizeTabState({
    tabId: 2,
    siteKey: 'alpha.test',
    pageUrl: 'https://one.alpha.test',
    pageHost: 'one.alpha.test',
    destinations: {},
    fingerprint: { signals: {} },
    paused: false,
    updatedAt: 500
  }, 9000);

  assert.equal(state.siteStartedAt, 500);
});

test('a destination keeps every transport it was contacted over', () => {
  let state = makeTabState(1, 1000);
  state = recordDestination(state, {
    value: 'cdn.example.com',
    party: 'third',
    requestType: 'script',
    transport: 'https'
  }, 1000);
  state = recordDestination(state, {
    value: 'cdn.example.com',
    party: 'third',
    requestType: 'image',
    transport: 'http'
  }, 2000);

  const destination = state.destinations['host|cdn.example.com'];
  assert.deepEqual(destination.transports, ['https', 'http']);
  assert.equal(destination.count, 2);
});

test('a transport already observed is not recorded twice', () => {
  let state = makeTabState(1, 1000);
  for (const at of [1000, 2000, 3000]) {
    state = recordDestination(state, {
      value: 'cdn.example.com',
      party: 'third',
      requestType: 'script',
      transport: 'wss'
    }, at);
  }

  assert.deepEqual(state.destinations['host|cdn.example.com'].transports, ['wss']);
});

test('a persisted destination keeps the transport it was stored with', () => {
  const state = normalizeTabState({
    tabId: 3,
    pageHost: 'news.example',
    destinations: {
      'host|cdn.example.com': {
        id: 'host|cdn.example.com',
        kind: 'host',
        value: 'cdn.example.com',
        party: 'third',
        requestType: 'script',
        transport: 'http',
        ips: {},
        firstSeen: 10,
        lastSeen: 10,
        count: 1
      }
    },
    fingerprint: { signals: {} },
    paused: false,
    updatedAt: 10
  }, 9000);

  assert.deepEqual(state.destinations['host|cdn.example.com'].transports, ['http']);
});
