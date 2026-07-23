import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeTabState,
  applyTopLevelNavigation,
  recordDestination,
  recordResolvedIp
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
