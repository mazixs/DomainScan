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

test('a row carries the transports of the destination it stands for', () => {
  const state = {
    pageHost: 'news.example',
    destinations: {
      'host|a.news.example': {
        id: 'host|a.news.example', kind: 'host', value: 'a.news.example',
        party: 'first', requestType: 'script', transports: ['https'],
        ips: {}, firstSeen: 1, lastSeen: 1, count: 1
      },
      'host|b.news.example': {
        id: 'host|b.news.example', kind: 'host', value: 'b.news.example',
        party: 'first', requestType: 'image', transports: ['http', 'https'],
        ips: {}, firstSeen: 2, lastSeen: 2, count: 1
      }
    }
  };

  const exact = buildDestinationRows(state, { mode: 'exact' });
  assert.deepEqual(exact.map((row) => row.transports), [['https'], ['http', 'https']]);

  const grouped = buildDestinationRows(state, { mode: 'registrable' });
  assert.deepEqual(grouped.map((row) => row.transports), [['https', 'http']]);
});

const FOLDING_STATE = {
  pageHost: 'news.example',
  destinations: {
    'host|img.deep.news.example': {
      id: 'host|img.deep.news.example', kind: 'host', value: 'img.deep.news.example',
      party: 'first', requestType: 'image', transports: ['https'],
      ips: {}, firstSeen: 1, lastSeen: 1, count: 1
    },
    'host|js.deep.news.example': {
      id: 'host|js.deep.news.example', kind: 'host', value: 'js.deep.news.example',
      party: 'first', requestType: 'script', transports: ['https'],
      ips: {}, firstSeen: 2, lastSeen: 2, count: 1
    },
    'host|news.example': {
      id: 'host|news.example', kind: 'host', value: 'news.example',
      party: 'first', requestType: 'document', transports: ['https'],
      ips: {}, firstSeen: 3, lastSeen: 3, count: 1
    },
    'ip|203.0.113.42': {
      id: 'ip|203.0.113.42', kind: 'ip', value: '203.0.113.42',
      party: 'ip', requestType: 'other', transports: ['https'],
      ips: {}, firstSeen: 4, lastSeen: 4, count: 1
    }
  }
};

test('the subdomain mode folds one label and keeps the host it folded from', () => {
  const rows = buildDestinationRows(FOLDING_STATE, { mode: 'collapse' });

  assert.deepEqual(rows.map((row) => row.display), [
    'deep.news.example',
    'deep.news.example',
    'news.example',
    '203.0.113.42'
  ]);
  assert.deepEqual(rows.map((row) => row.foldedFrom), [
    'img.deep.news.example',
    'js.deep.news.example',
    null,
    null
  ]);
});

test('the subdomain mode keeps one row per observed host', () => {
  const rows = buildDestinationRows(FOLDING_STATE, { mode: 'collapse' });
  const exact = buildDestinationRows(FOLDING_STATE, { mode: 'exact' });

  assert.equal(rows.length, exact.length);
  assert.deepEqual(rows.map((row) => row.grouped), [1, 1, 1, 1]);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test('the exact mode states hosts as observed and folds nothing', () => {
  const rows = buildDestinationRows(FOLDING_STATE, { mode: 'exact' });

  assert.deepEqual(rows.map((row) => row.display), [
    'img.deep.news.example',
    'js.deep.news.example',
    'news.example',
    '203.0.113.42'
  ]);
  assert.deepEqual(rows.map((row) => row.foldedFrom), [null, null, null, null]);
});

test('the registrable mode still groups hosts of one domain', () => {
  const rows = buildDestinationRows(FOLDING_STATE, { mode: 'registrable' });

  assert.deepEqual(rows.map((row) => row.display), ['news.example', '203.0.113.42']);
  assert.deepEqual(rows.map((row) => row.grouped), [3, 1]);
  // A grouped row stands for several hosts, so naming one of them would misstate it.
  assert.deepEqual(rows.map((row) => row.foldedFrom), [null, null]);
});

test('a row states how the destination was reached', () => {
  const state = {
    pageHost: 'app.pwa.test',
    destinations: {
      'host|a.vendor.test': {
        id: 'host|a.vendor.test', kind: 'host', value: 'a.vendor.test',
        party: 'third', requestType: 'fetch', transports: ['https'], sources: ['page'],
        ips: {}, firstSeen: 1, lastSeen: 1, count: 1
      },
      'host|b.vendor.test': {
        id: 'host|b.vendor.test', kind: 'host', value: 'b.vendor.test',
        party: 'third', requestType: 'fetch', transports: ['https'], sources: ['worker'],
        ips: {}, firstSeen: 2, lastSeen: 2, count: 1
      },
      'host|c.vendor.test': {
        id: 'host|c.vendor.test', kind: 'host', value: 'c.vendor.test',
        party: 'third', requestType: 'fetch', transports: ['https'], sources: ['page', 'worker'],
        ips: {}, firstSeen: 3, lastSeen: 3, count: 1
      }
    }
  };

  assert.deepEqual(
    buildDestinationRows(state, { mode: 'exact' }).map((row) => row.sources),
    [['page'], ['worker'], ['page', 'worker']]
  );
  assert.deepEqual(
    buildDestinationRows(state, { mode: 'registrable' }).map((row) => row.sources),
    [['page', 'worker']]
  );
});
