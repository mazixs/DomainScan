import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDestinationRows,
  collectVisibleDomains,
  collectVisibleIps
} from '../src/sidepanel/view-model.js';

function stateWithDestinations() {
  return {
    destinations: {
      'host|cdn.news.example.co.uk': {
        id: 'host|cdn.news.example.co.uk',
        kind: 'host',
        value: 'cdn.news.example.co.uk',
        party: 'first',
        requestType: 'script',
        firstSeen: 1,
        ips: {
          '203.0.113.10': { value: '203.0.113.10' },
          '2001:db8::10': { value: '2001:db8::10' }
        }
      },
      'host|img.news.example.co.uk': {
        id: 'host|img.news.example.co.uk',
        kind: 'host',
        value: 'img.news.example.co.uk',
        party: 'first',
        requestType: 'image',
        firstSeen: 2,
        ips: {
          '203.0.113.10': { value: '203.0.113.10' },
          '203.0.113.11': { value: '203.0.113.11' }
        }
      },
      'ip|192.0.2.4': {
        id: 'ip|192.0.2.4',
        kind: 'ip',
        value: '192.0.2.4',
        party: 'ip',
        requestType: 'fetch',
        firstSeen: 3,
        ips: {}
      }
    }
  };
}

test('exact rows expose every resolved address on its hostname', () => {
  const rows = buildDestinationRows(stateWithDestinations(), { mode: 'exact' });

  assert.deepEqual(rows[0].ips, ['203.0.113.10', '2001:db8::10']);
  assert.deepEqual(rows[1].ips, ['203.0.113.10', '203.0.113.11']);
  assert.deepEqual(rows[2].ips, ['192.0.2.4']);
});

test('registrable view groups subdomains and merges resolved addresses', () => {
  const rows = buildDestinationRows(stateWithDestinations(), { mode: 'registrable' });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].display, 'example.co.uk');
  assert.equal(rows[0].grouped, 2);
  assert.deepEqual(rows[0].ips, ['203.0.113.10', '2001:db8::10', '203.0.113.11']);
  assert.deepEqual(rows[0].requestTypes, ['script', 'image']);
});

test('bulk IP copy includes resolved and direct addresses exactly once', () => {
  const rows = buildDestinationRows(stateWithDestinations(), { mode: 'exact' });

  assert.deepEqual(collectVisibleIps(rows), [
    '203.0.113.10',
    '2001:db8::10',
    '203.0.113.11',
    '192.0.2.4'
  ]);
});

test('domain copy excludes direct IP rows and respects the search-filtered rows', () => {
  const rows = buildDestinationRows(stateWithDestinations(), {
    mode: 'exact',
    query: 'img.'
  });

  assert.deepEqual(collectVisibleDomains(rows), ['img.news.example.co.uk']);
  assert.deepEqual(collectVisibleIps(rows), ['203.0.113.10', '203.0.113.11']);
});
