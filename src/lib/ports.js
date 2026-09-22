// URL destination ports, not remote socket ports (webRequest does not expose those).
export function requestPort(parsed) {
  if (parsed.port !== '') return Number(parsed.port);
  return ({ 'https:': 443, 'http:': 80, 'wss:': 443, 'ws:': 80, 'ftp:': 21 })[parsed.protocol] ?? null;
}

export function normalizePorts(ports) {
  return [...new Set((Array.isArray(ports) ? ports : []).filter(
    (port) => Number.isInteger(port) && port >= 0 && port <= 65535
  ))];
}

export function withPort(host, port) {
  if (port == null) return host;
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
