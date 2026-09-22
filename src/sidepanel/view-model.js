import { normalizePorts, withPort } from '../lib/ports.js';
import { foldSubdomain, registrableDomain } from '../lib/domain.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function destinationIps(destination, port, showPorts) {
  if (destination.kind === 'ip') return [withPort(destination.value, port)];
  return unique(Object.values(destination.ips || {}).flatMap((address) => {
    if (!address || !address.value) return [];
    const ports = normalizePorts(address.ports);
    if (!showPorts || ports.length === 0) return [address.value];
    return ports.includes(port) ? [withPort(address.value, port)] : [];
  }));
}

function displayValue(destination, mode) {
  if (destination.kind !== 'host') return destination.value;
  if (mode === 'registrable') return registrableDomain(destination.value);
  if (mode === 'collapse') return foldSubdomain(destination.value);
  return destination.value;
}

export function buildDestinationRows(state, { mode = 'exact', query = '', showPorts = false } = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const destinations = Object.values((state && state.destinations) || {})
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .flatMap((destination) => {
      const ports = showPorts ? normalizePorts(destination.ports) : [];
      return (ports.length ? ports : [null]).map((port) => ({ destination, port }));
    });
  const rows = [];
  const groupedRows = new Map();

  for (const { destination, port } of destinations) {
    const evidence = (port != null && destination.portDetails?.[port]) || destination;
    const display = withPort(displayValue(destination, mode), port);
    const ips = destinationIps(destination, port, showPorts);
    if (normalizedQuery && !withPort(destination.value, port).toLowerCase().includes(normalizedQuery) &&
        !ips.some((ip) => ip.includes(normalizedQuery))) continue;
    const key = mode === 'registrable'
      ? `registrable|${destination.kind}|${display}`
      : `${mode}|${destination.id}${port == null ? '' : `|${port}`}`;
    const existing = mode === 'registrable' ? groupedRows.get(key) : null;

    if (existing) {
      existing.grouped += 1;
      existing.ips = unique([...existing.ips, ...ips]);
      existing.requestTypes = unique([...existing.requestTypes, ...(evidence.requestTypes || [])]);
      existing.transports = unique([...existing.transports, ...(evidence.transports || [])]);
      existing.sources = unique([...existing.sources, ...(evidence.sources || [])]);
      if (destination.party === 'third') existing.party = 'third';
      continue;
    }

    const row = {
      key,
      display,
      // The host a folded row stands for. A grouped row stands for several, so it
      // names none of them and says how many instead.
      foldedFrom: mode === 'collapse' && displayValue(destination, mode) !== destination.value
        ? withPort(destination.value, port) : null,
      kind: destination.kind,
      party: destination.party,
      requestTypes: unique(evidence.requestTypes || []),
      transports: unique(evidence.transports || []),
      sources: unique(evidence.sources || []),
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
