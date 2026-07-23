// Public Suffix List subset for DomainScan.
//
// Only MULTI-LABEL public suffixes need to be listed here. Single-label TLDs (com, org, io,
// example, test, uk, …) are handled by the default rule in domain.js (the rightmost label is
// treated as the public suffix), so they don't need entries.
//
// PRODUCTION NOTE: for full correctness, replace this curated subset with the complete list from
// https://publicsuffix.org/list/public_suffix_list.dat (parsed into the same three sets). This
// subset covers the common multi-label suffixes and is correct for the vast majority of sites.

export const PUBLIC_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz', 'school.nz',
  // Japan
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  // South Korea
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'go.kr', 'ac.kr', 'pe.kr',
  // China / Hong Kong
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
  // India
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br',
  // Mexico / Argentina / Colombia
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx', 'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  // South Africa
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  // Europe (selected)
  'co.at', 'or.at', 'ac.at', 'gv.at', 'com.es', 'org.es', 'edu.es', 'gob.es', 'com.pl', 'net.pl',
  'org.pl', 'gov.pl', 'edu.pl', 'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'com.ua',
  'com.gr', 'net.gr', 'org.gr', 'gov.gr', 'edu.gr',
  // Russia / CIS
  'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru', 'com.by', 'com.kz', 'org.kz',
  // Israel / Singapore / others
  'co.il', 'org.il', 'net.il', 'gov.il', 'ac.il', 'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  // Common vanity suffixes
  'blogspot.com', 'github.io', 'pages.dev', 'web.app', 'firebaseapp.com'
]);

// Wildcard rules: any single label directly under one of these is itself a public suffix
// (e.g. `*.ck` means `foo.ck` is a public suffix). Stored as the parent label.
export const WILDCARD_SUFFIXES = new Set([
  'ck', 'bd', 'ke', 'mm', 'np', 'pg', 'jm', 'fj'
]);

// Exception rules: these registrable domains are explicitly NOT public suffixes even though a
// wildcard would otherwise capture them (PSL `!` rules).
export const EXCEPTION_SUFFIXES = new Set([
  'www.ck'
]);
