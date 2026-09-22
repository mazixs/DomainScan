import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPort, normalizePorts, withPort } from '../src/lib/ports.js';
import { makeTabState, recordDestination, recordResolvedIp, normalizeTabState } from '../src/lib/tab-state.js';
import { buildDestinationRows, collectVisibleIps, collectVisibleDomains } from '../src/sidepanel/view-model.js';

test('URL ports include explicit values and defaults, without guessing unknown protocols', () => {
  for (const [url, port] of [
    ['https://example.com', 443], ['http://example.com:80', 80],
    ['wss://example.com', 443], ['ws://example.com', 80],
    ['wss://[2001:db8::1]:8443/socket', 8443], ['https://example.com:65535', 65535],
    ['custom://example.com', null], ['custom://example.com:1234', 1234]
  ]) assert.equal(requestPort(new URL(url)), port);
  assert.deepEqual(normalizePorts([443, 443, -1, 65536, null, '80', 1.5]), [443]);
  assert.equal(withPort('2001:db8::1', 443), '[2001:db8::1]:443');
  assert.equal(withPort('[::1]', 8080), '[::1]:8080');
});

function portState() {
  let state = makeTabState(1);
  for (const [port, transport, ip] of [[443, 'https', '2001:db8::1'], [8080, 'http', '192.0.2.1']]) {
    state = recordDestination(state, {
      value: 'api.example.com', port, transport, requestType: 'fetch', source: 'page', party: 'third'
    });
    state = recordResolvedIp(state, 'api.example.com', ip, 10, port);
  }
  return state;
}

test('port and IP associations survive storage and do not invent IP/port combinations', () => {
  const state = normalizeTabState(JSON.parse(JSON.stringify(portState())));
  const rows = buildDestinationRows(state, { showPorts: true });
  assert.deepEqual(collectVisibleDomains(rows), ['api.example.com:443', 'api.example.com:8080']);
  assert.deepEqual(collectVisibleIps(rows), ['[2001:db8::1]:443', '192.0.2.1:8080']);
  assert.deepEqual(rows.map((row) => row.transports), [['https'], ['http']]);
  assert.equal(buildDestinationRows(state).length, 1);
  assert.deepEqual(collectVisibleIps(buildDestinationRows(state)), ['2001:db8::1', '192.0.2.1']);
  assert.deepEqual(collectVisibleIps(buildDestinationRows(state, { showPorts: true, query: ':8080' })), ['192.0.2.1:8080']);
});

test('grouping keeps different ports separate and direct IPv6 copies retain brackets', () => {
  let state = portState();
  state = recordDestination(state, { value: 'cdn.example.com', port: 443 });
  state = recordDestination(state, { value: '2001:db8::2', port: 8443 });
  const rows = buildDestinationRows(state, { showPorts: true, mode: 'registrable' });
  assert.deepEqual(rows.map((row) => row.display), ['example.com:443', 'example.com:8080', '[2001:db8::2]:8443']);
  assert.equal(rows[0].grouped, 2);
  assert.deepEqual(collectVisibleIps(rows), ['[2001:db8::1]:443', '192.0.2.1:8080', '[2001:db8::2]:8443']);
});

test('old records never acquire invented ports from their transport or other IPs', () => {
  const state = normalizeTabState({ tabId: 1, destinations: {
    old: { value: 'old.example', kind: 'host', transports: ['https'], ips: { a: { value: '192.0.2.1' } } }
  } });
  const rows = buildDestinationRows(state, { showPorts: true });
  assert.equal(rows[0].display, 'old.example');
  assert.deepEqual(rows[0].ips, ['192.0.2.1']);
});
