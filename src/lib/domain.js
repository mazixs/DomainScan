// Pure domain logic for DomainScan. No chrome.* APIs, no DOM — safe to unit-test in node.
// See docs/ARCHITECTURE.md for the contract. Consumed by the service worker (party/kind) and the
// side panel (display modes), which MUST agree, so both import from here.

import { PUBLIC_SUFFIXES, WILDCARD_SUFFIXES, EXCEPTION_SUFFIXES } from './psl-data.js';

function hasRule(sortedRules, value) {
  let low = 0;
  let high = sortedRules.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const rule = sortedRules[middle];
    if (rule === value) return true;
    if (rule < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/** Normalize a hostname: lowercase, strip a trailing dot and IPv6 brackets. */
function normalizeHost(host) {
  if (!host) return '';
  let h = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (/[^\u0000-\u007f]/.test(h)) {
    try {
      h = new URL(`http://${h}`).hostname.toLowerCase().replace(/\.$/, '');
    } catch (_error) {
      return '';
    }
  }
  return h;
}

function parseIpv4(value) {
  const octets = value.split('.');
  if (octets.length !== 4) return null;
  const parsed = [];
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    if (octet.length > 1 && octet.startsWith('0')) return null;
    const number = Number(octet);
    if (number > 255) return null;
    parsed.push(number);
  }
  return parsed;
}

function parseIpv6Parts(parts) {
  const parsed = [];
  for (const part of parts) {
    if (!part || !/^[0-9a-f]{1,4}$/i.test(part)) return null;
    parsed.push(Number.parseInt(part, 16));
  }
  return parsed;
}

function parseIpv6(value) {
  if (!value.includes(':') || value.includes('%')) return null;

  let expanded = value;
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(expanded.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    expanded = `${expanded.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compressed = expanded.includes('::');
  const halves = expanded.split('::');
  if (halves.length > 2) return null;

  const left = parseIpv6Parts(halves[0] ? halves[0].split(':') : []);
  const right = parseIpv6Parts(compressed && halves[1] ? halves[1].split(':') : []);
  if (!left || !right) return null;

  const explicitCount = left.length + right.length;
  if ((!compressed && explicitCount !== 8) || (compressed && explicitCount >= 8)) return null;
  return compressed
    ? [...left, ...Array(8 - explicitCount).fill(0), ...right]
    : left;
}

function formatIpv6(groups) {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < groups.length && groups[end] === 0) end += 1;
    const length = end - i;
    if (length > bestLength && length >= 2) {
      bestStart = i;
      bestLength = length;
    }
    i = end;
  }

  const parts = groups.map((group) => group.toString(16));
  if (bestStart < 0) return parts.join(':');
  const left = parts.slice(0, bestStart).join(':');
  const right = parts.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

/** Return a stable representation of an IP literal, or null for non-IP input. */
export function normalizeIpLiteral(value) {
  if (!value) return null;
  let candidate = String(value).trim().toLowerCase();
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1);
  }

  const ipv4 = parseIpv4(candidate);
  if (ipv4) return ipv4.join('.');
  const ipv6 = parseIpv6(candidate);
  return ipv6 ? formatIpv6(ipv6) : null;
}

/** True only for a syntactically valid IPv4 or IPv6 literal. */
export function isIpLiteral(value) {
  return normalizeIpLiteral(value) !== null;
}

/**
 * Registrable domain (eTLD+1) for a hostname, using the bundled full PSL snapshot.
 * Falls back to the last two labels when no suffix matches. IP literals and
 * single-label hosts are returned unchanged.
 */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h) return h;
  const ip = normalizeIpLiteral(h);
  if (ip) return ip;
  const labels = h.split('.');
  if (labels.length <= 1) return h;

  // Default rule: the rightmost label is the public suffix (suffixLabels = 1).
  let suffixLabels = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');

    // Exception rule (!foo.bar): public suffix is the candidate minus its leftmost label.
    if (hasRule(EXCEPTION_SUFFIXES, candidate)) {
      suffixLabels = labels.length - i - 1;
      break;
    }
    // Explicit multi-label public suffix — first match from the left is the longest.
    if (hasRule(PUBLIC_SUFFIXES, candidate)) {
      suffixLabels = labels.length - i;
      break;
    }
    // Wildcard rule (*.parent): candidate is a public suffix if its parent is a wildcard base.
    const parent = labels.slice(i + 1).join('.');
    if (parent && hasRule(WILDCARD_SUFFIXES, parent)) {
      suffixLabels = labels.length - i;
      break;
    }
  }

  const registrableLabels = Math.min(labels.length, suffixLabels + 1);
  return labels.slice(labels.length - registrableLabels).join('.');
}

/** Stable site-session key: registrable domain, normalized IP, or single-label host. */
export function siteKeyForHost(host) {
  return registrableDomain(host);
}

/**
 * Classify a destination relative to the page's host.
 * IP literals are 'ip'. Otherwise compare registrable domains: same → 'first', else 'third'.
 */
export function classifyParty(destValue, pageHost) {
  if (isIpLiteral(destValue)) return 'ip';
  const page = normalizeHost(pageHost);
  if (!page) return 'third';
  return registrableDomain(destValue) === registrableDomain(page) ? 'first' : 'third';
}
