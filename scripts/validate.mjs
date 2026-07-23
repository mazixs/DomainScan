#!/usr/bin/env node
// Static validation for the DomainScan extension package: manifest sanity, referenced files exist,
// locale JSON validity, manifest __MSG_*__ keys resolve, and cross-locale key parity.
// Exits non-zero on any problem. Used by CI and safe to run locally: `node scripts/validate.mjs`.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

// ---- manifest ----
let manifest;
try {
  manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
} catch (e) {
  console.error('FATAL: manifest.json is not valid JSON —', e.message);
  process.exit(1);
}

check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(typeof manifest.version === 'string' && /^\d+(\.\d+){0,3}$/.test(manifest.version),
  `manifest.version must be a dotted number, got ${JSON.stringify(manifest.version)}`);
check(!!manifest.default_locale, 'manifest.default_locale is required when using _locales');

// ---- referenced files exist ----
const refs = [];
if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
if (manifest.side_panel?.default_path) refs.push(manifest.side_panel.default_path);
for (const cs of manifest.content_scripts ?? []) for (const j of cs.js ?? []) refs.push(j);
for (const p of Object.values(manifest.icons ?? {})) refs.push(p);
for (const p of Object.values(manifest.action?.default_icon ?? {})) refs.push(p);
for (const r of refs) check(existsSync(r), `manifest references a missing file: ${r}`);

// ---- locales ----
const localesDir = '_locales';
const localeKeys = {};
if (!existsSync(localesDir)) {
  errors.push('_locales directory is missing');
} else {
  for (const loc of readdirSync(localesDir)) {
    const f = path.join(localesDir, loc, 'messages.json');
    if (!existsSync(f)) { errors.push(`locale "${loc}" has no messages.json`); continue; }
    try {
      localeKeys[loc] = Object.keys(JSON.parse(readFileSync(f, 'utf8'))).sort();
    } catch (e) {
      errors.push(`locale "${loc}" messages.json is invalid JSON — ${e.message}`);
    }
  }
}

const def = manifest.default_locale;
check(!!localeKeys[def], `default_locale "${def}" has no valid messages.json`);

// ---- manifest __MSG_x__ keys resolve in the default locale ----
if (localeKeys[def]) {
  const defSet = new Set(localeKeys[def]);
  const used = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]);
  for (const key of used) check(defSet.has(key), `manifest uses __MSG_${key}__ but "${key}" is missing from the ${def} locale`);
}

// ---- cross-locale key parity ----
if (localeKeys[def]) {
  const base = localeKeys[def];
  for (const [loc, keys] of Object.entries(localeKeys)) {
    if (loc === def) continue;
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    check(missing.length === 0, `locale "${loc}" is missing keys: ${missing.join(', ')}`);
    check(extra.length === 0, `locale "${loc}" has extra keys not in ${def}: ${extra.join(', ')}`);
  }
}

if (errors.length) {
  console.error('VALIDATION FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`Validation passed: manifest v${manifest.version}, locales [${Object.keys(localeKeys).join(', ')}] consistent.`);
