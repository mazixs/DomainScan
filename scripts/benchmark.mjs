// Synthetic CPU benchmarks, independent of browser/network latency.
import { performance } from 'node:perf_hooks';
import { createTabStateAccumulator, makeTabState, recordDestination } from '../src/lib/tab-state.js';
import { buildDestinationRows } from '../src/sidepanel/view-model.js';

const observation = (index) => ({
  value: `h${index}.alpha.test`, party: 'first', requestType: 'script',
  transport: 'https', port: 443, source: 'page'
});

function fixture(size) {
  const state = makeTabState(1, 1);
  for (let index = 0; index < size; index += 1) {
    const entry = Object.values(recordDestination(makeTabState(1, 1), observation(index), index + 2).destinations)[0];
    const ip = `2001:db8::${(index + 1).toString(16)}`;
    entry.ips[ip] = { value: ip, ports: [443], firstSeen: 2, lastSeen: 2, count: 1 };
    state.destinations[entry.id] = entry;
  }
  return state;
}

function median(run) {
  const times = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return Number(times.sort((a, b) => a - b)[1].toFixed(2));
}

for (const size of [1000, 5000, 10000]) {
  const initial = fixture(size);
  const observed = observation(0);
  const immutableMs = median(() => {
    let state = initial;
    for (let index = 0; index < 1000; index += 1) state = recordDestination(state, observed, index + 2);
  });
  const accumulatorMs = median(() => {
    const draft = createTabStateAccumulator();
    let state = initial;
    for (let index = 0; index < 1000; index += 1) state = draft.recordDestination(state, observed, index + 2);
    draft.snapshot(state);
  });
  const groupedIpsMs = median(() => buildDestinationRows(initial, { mode: 'registrable' }));
  console.log(JSON.stringify({ destinations: size, requests: 1000, immutableMs, accumulatorMs, groupedIpsMs }));
}
