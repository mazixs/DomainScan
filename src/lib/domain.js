// Pure domain logic for DomainScan. No chrome.* APIs, no DOM — safe to unit-test in node.
// See docs/ARCHITECTURE.md for the contract. Consumed by the service worker (party/kind) and the
// side panel (display modes), which MUST agree, so both import from here.

import { PUBLIC_SUFFIXES, WILDCARD_SUFFIXES, EXCEPTION_SUFFIXES } from './psl-data.js';

/** Normalize a hostname: lowercase, strip a trailing dot and IPv6 brackets. */
function normalizeHost(host) {
  if (!host) return '';
  let h = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

/** True for an IPv4 or IPv6 literal. */
export function isIpLiteral(value) {
  if (!value) return false;
  const v = normalizeHost(value);
  // IPv6 literals contain a colon; IPv4 is four dotted octets.
  if (v.includes(':')) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return false;
  return v.split('.').every((o) => Number(o) <= 255);
}

/**
 * Registrable domain (eTLD+1) for a hostname, using the bundled PSL subset.
 * Falls back to the last two labels when no multi-label suffix matches. IP literals and
 * single-label hosts are returned unchanged.
 */
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h || isIpLiteral(h)) return h;
  const labels = h.split('.');
  if (labels.length <= 1) return h;

  // Default rule: the rightmost label is the public suffix (suffixLabels = 1).
  let suffixLabels = 1;
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');

    // Exception rule (!foo.bar): public suffix is the candidate minus its leftmost label.
    if (EXCEPTION_SUFFIXES.has(candidate)) {
      suffixLabels = labels.length - i - 1;
      break;
    }
    // Explicit multi-label public suffix — first match from the left is the longest.
    if (PUBLIC_SUFFIXES.has(candidate)) {
      suffixLabels = labels.length - i;
      break;
    }
    // Wildcard rule (*.parent): candidate is a public suffix if its parent is a wildcard base.
    const parent = labels.slice(i + 1).join('.');
    if (parent && WILDCARD_SUFFIXES.has(parent)) {
      suffixLabels = labels.length - i;
      break;
    }
  }

  const registrableLabels = Math.min(labels.length, suffixLabels + 1);
  return labels.slice(labels.length - registrableLabels).join('.');
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
