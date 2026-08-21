import { foldSubdomain, registrableDomain } from '../lib/domain.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function destinationIps(destination) {
  if (destination.kind === 'ip') return [destination.value];
  return unique(Object.values(destination.ips || {}).map((address) => address && address.value));
}

function sourceDestinations(state, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  return Object.values((state && state.destinations) || {})
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .filter((destination) => {
      if (!normalizedQuery) return true;
      return destination.value.toLowerCase().includes(normalizedQuery) ||
        destinationIps(destination).some((ip) => ip.includes(normalizedQuery));
    });
}

function displayValue(destination, mode) {
  if (destination.kind !== 'host') return destination.value;
  if (mode === 'registrable') return registrableDomain(destination.value);
  if (mode === 'collapse') return foldSubdomain(destination.value);
  return destination.value;
}

export function buildDestinationRows(state, { mode = 'exact', query = '' } = {}) {
  const destinations = sourceDestinations(state, query);
  const rows = [];
  const groupedRows = new Map();

  for (const destination of destinations) {
    const display = displayValue(destination, mode);
    const key = mode === 'registrable'
      ? `registrable|${destination.kind}|${display}`
      : `${mode}|${destination.id}`;
    const ips = destinationIps(destination);
    const existing = mode === 'registrable' ? groupedRows.get(key) : null;

    if (existing) {
      existing.grouped += 1;
      existing.ips = unique([...existing.ips, ...ips]);
      existing.requestTypes = unique([...existing.requestTypes, ...(destination.requestTypes || [])]);
      existing.transports = unique([...existing.transports, ...(destination.transports || [])]);
      existing.sources = unique([...existing.sources, ...(destination.sources || [])]);
      if (destination.party === 'third') existing.party = 'third';
      continue;
    }

    const row = {
      key,
      display,
      // The host a folded row stands for. A grouped row stands for several, so it
      // names none of them and says how many instead.
      foldedFrom: mode === 'collapse' && display !== destination.value ? destination.value : null,
      kind: destination.kind,
      party: destination.party,
      requestTypes: unique(destination.requestTypes || []),
      transports: unique(destination.transports || []),
      sources: unique(destination.sources || []),
      grouped: 1,
      ips
    };
    rows.push(row);
    if (mode === 'registrable') groupedRows.set(key, row);
  }

  return rows;
}

export function collectVisibleDomains(rows) {
  return unique(rows.filter((row) => row.kind === 'host').map((row) => row.display));
}

export function collectVisibleIps(rows) {
  return unique(rows.flatMap((row) => row.ips || []));
}
