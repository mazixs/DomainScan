import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDestinationRows,
  captureCheckpoint,
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
        requestTypes: ['script'],
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
        requestTypes: ['image'],
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
        requestTypes: ['fetch'],
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
  assert.deepEqual(rows[0].members.map((member) => member.value), [
    'cdn.news.example.co.uk', 'img.news.example.co.uk'
  ]);
});

test('filters apply to exact destinations before domain grouping and copying', () => {
  const state = stateWithDestinations();
  state.destinations['host|cdn.news.example.co.uk'].transports = ['http'];
  state.destinations['host|img.news.example.co.uk'].transports = ['https'];
  state.destinations['host|cdn.news.example.co.uk'].sources = ['worker'];
  state.destinations['host|img.news.example.co.uk'].sources = ['page'];

  const rows = buildDestinationRows(state, {
    mode: 'registrable',
    filters: { party: 'first', feature: 'unencrypted', requestType: 'script' }
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].members.map((member) => member.value), ['cdn.news.example.co.uk']);
  assert.deepEqual(collectVisibleIps(rows), ['203.0.113.10', '2001:db8::10']);
  assert.equal(buildDestinationRows(state, { filters: { feature: 'worker' } }).length, 1);
});

test('checkpoint shows new and repeated requests, including the exact port', () => {
  const state = {
    tabId: 1, siteKey: 'example.test', siteStartedAt: 10,
    destinations: {
      'host|a.example.test': {
        id: 'host|a.example.test', kind: 'host', value: 'a.example.test', party: 'first',
        firstSeen: 11, count: 2, ports: [443], requestTypes: ['fetch'],
        portDetails: {
          443: { count: 2, requestTypes: ['fetch'], transports: ['https'], sources: ['page'] }
        }, ips: {}
      }
    }
  };
  const checkpoint = captureCheckpoint(state);
  assert.deepEqual(buildDestinationRows(state, { checkpoint, showPorts: true }), []);

  state.destinations['host|a.example.test'].count = 4;
  state.destinations['host|a.example.test'].ports.push(8443);
  state.destinations['host|a.example.test'].portDetails[443].count = 3;
  state.destinations['host|a.example.test'].portDetails[8443] = {
    count: 1, requestTypes: ['fetch'], transports: ['https'], sources: ['page']
  };
  state.destinations['host|b.example.test'] = {
    id: 'host|b.example.test', kind: 'host', value: 'b.example.test', party: 'first',
    firstSeen: 12, count: 1, requestTypes: ['image'], ports: [], ips: {}
  };
  const rows = buildDestinationRows(state, { checkpoint, showPorts: true, mode: 'registrable' });
  assert.deepEqual(rows.map((row) => row.display), ['example.test:443', 'example.test:8443', 'example.test']);
  assert.deepEqual(rows.map((row) => row.changeStatus), ['repeat', 'new', 'new']);
  assert.deepEqual(rows.map((row) => row.changeCount), [1, 1, 1]);
});

test('a transport filter never attributes one URL port to another', () => {
  const state = {
    destinations: {
      'host|api.example.test': {
        id: 'host|api.example.test', kind: 'host', value: 'api.example.test', party: 'third',
        firstSeen: 1, count: 2, ports: [80, 443], requestTypes: ['fetch'], transports: ['http', 'https'],
        portDetails: {
          80: { count: 1, requestTypes: ['fetch'], transports: ['http'], sources: ['page'] },
          443: { count: 1, requestTypes: ['fetch'], transports: ['https'], sources: ['page'] }
        }, ips: {}
      }
    }
  };
  const rows = buildDestinationRows(state, {
    showPorts: true, filters: { feature: 'unencrypted' }
  });
  assert.deepEqual(rows.map((row) => row.display), ['api.example.test:80']);
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
        party: 'first', requestTypes: ['script'], transports: ['https'],
        ips: {}, firstSeen: 1, lastSeen: 1, count: 1
      },
      'host|b.news.example': {
        id: 'host|b.news.example', kind: 'host', value: 'b.news.example',
        party: 'first', requestTypes: ['image'], transports: ['http', 'https'],
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
      party: 'first', requestTypes: ['image'], transports: ['https'],
      ips: {}, firstSeen: 1, lastSeen: 1, count: 1
    },
    'host|js.deep.news.example': {
      id: 'host|js.deep.news.example', kind: 'host', value: 'js.deep.news.example',
      party: 'first', requestTypes: ['script'], transports: ['https'],
      ips: {}, firstSeen: 2, lastSeen: 2, count: 1
    },
    'host|news.example': {
      id: 'host|news.example', kind: 'host', value: 'news.example',
      party: 'first', requestTypes: ['document'], transports: ['https'],
      ips: {}, firstSeen: 3, lastSeen: 3, count: 1
    },
    'ip|203.0.113.42': {
      id: 'ip|203.0.113.42', kind: 'ip', value: '203.0.113.42',
      party: 'ip', requestTypes: ['other'], transports: ['https'],
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
        party: 'third', requestTypes: ['fetch'], transports: ['https'], sources: ['page'],
        ips: {}, firstSeen: 1, lastSeen: 1, count: 1
      },
      'host|b.vendor.test': {
        id: 'host|b.vendor.test', kind: 'host', value: 'b.vendor.test',
        party: 'third', requestTypes: ['fetch'], transports: ['https'], sources: ['worker'],
        ips: {}, firstSeen: 2, lastSeen: 2, count: 1
      },
      'host|c.vendor.test': {
        id: 'host|c.vendor.test', kind: 'host', value: 'c.vendor.test',
        party: 'third', requestTypes: ['fetch'], transports: ['https'], sources: ['page', 'worker'],
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

test('a row exposes every category the destination was seen as', () => {
  const state = {
    pageHost: 'news.example',
    destinations: {
      'host|cdn.news.example': {
        id: 'host|cdn.news.example', kind: 'host', value: 'cdn.news.example',
        party: 'first', requestTypes: ['image', 'document'], transports: ['https'], sources: ['page'],
        ips: {}, firstSeen: 1, lastSeen: 1, count: 2
      }
    }
  };

  assert.deepEqual(
    buildDestinationRows(state, { mode: 'exact' })[0].requestTypes,
    ['image', 'document']
  );
});

test('grouped IPs preserve first-seen order and deduplicate across many exact hosts', () => {
  const state = { destinations: {} };
  const addresses = [];
  for (let index = 0; index < 1000; index += 1) {
    const value = `h${index}.example.test`;
    const ip = `2001:db8::${(index + 1).toString(16)}`;
    addresses.push(ip);
    state.destinations[`host|${value}`] = {
      id: `host|${value}`, kind: 'host', value, party: 'first', firstSeen: index,
      requestTypes: ['fetch'], ips: { '203.0.113.10': { value: '203.0.113.10' }, [ip]: { value: ip } }
    };
  }
  const rows = buildDestinationRows(state, { mode: 'registrable' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grouped, 1000);
  assert.equal(rows[0].members.length, 1000);
  assert.deepEqual(rows[0].ips, ['203.0.113.10', ...addresses]);
  assert.equal('ipSet' in rows[0], false);
});
