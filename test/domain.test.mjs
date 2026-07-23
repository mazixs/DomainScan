// Unit tests for src/lib/domain.js — run with: node --test test/domain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  registrableDomain,
  isIpLiteral,
  classifyParty,
  siteKeyForHost,
  normalizeIpLiteral
} from '../src/lib/domain.js';

test('registrableDomain: two-label host is returned unchanged', () => {
  assert.equal(registrableDomain('news.example'), 'news.example');
});

test('registrableDomain: strips a single subdomain label', () => {
  assert.equal(registrableDomain('img.news.example'), 'news.example');
});

test('registrableDomain: collapses deeper subdomains to eTLD+1', () => {
  assert.equal(registrableDomain('static.edge.test'), 'edge.test');
});

test('registrableDomain: handles multi-label suffix co.uk', () => {
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
});

test('registrableDomain: handles multi-label suffix com.au with deep subdomains', () => {
  assert.equal(registrableDomain('a.b.example.com.au'), 'example.com.au');
});

test('registrableDomain: treats github.io as a public suffix (vanity)', () => {
  assert.equal(registrableDomain('foo.github.io'), 'foo.github.io');
});

test('registrableDomain: applies private, wildcard, and exception rules from the full PSL', () => {
  assert.equal(registrableDomain('a.b.dyndns.org'), 'b.dyndns.org');
  assert.equal(registrableDomain('a.b.nom.br'), 'a.b.nom.br');
  assert.equal(registrableDomain('www.city.kawasaki.jp'), 'city.kawasaki.jp');
});

test('registrableDomain: normalizes internationalized hostnames to ASCII', () => {
  assert.equal(registrableDomain('www.食狮.com.cn'), 'xn--85x722f.com.cn');
});

test('registrableDomain: single subdomain over a single-label TLD', () => {
  assert.equal(registrableDomain('shop.example.org'), 'example.org');
});

test('registrableDomain: single-label host is returned unchanged', () => {
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('isIpLiteral: true for an IPv4 literal', () => {
  assert.equal(isIpLiteral('203.0.113.42'), true);
});

test('isIpLiteral: true for an IPv6 literal', () => {
  assert.equal(isIpLiteral('2001:db8::1'), true);
});

test('isIpLiteral: false for a hostname', () => {
  assert.equal(isIpLiteral('news.example'), false);
});

test('isIpLiteral: false for an out-of-range dotted-quad', () => {
  assert.equal(isIpLiteral('999.1.1.1'), false);
});

test('isIpLiteral: rejects colon-containing values that are not valid IPv6', () => {
  assert.equal(isIpLiteral('not:an:ip'), false);
  assert.equal(isIpLiteral('host:443'), false);
  assert.equal(isIpLiteral('2001:db8:::1'), false);
  assert.equal(isIpLiteral('1:2:3:4:5:6:7:8:9'), false);
  assert.equal(isIpLiteral('192.0.2.1::'), false);
  assert.equal(isIpLiteral('1.2.3.4::'), false);
});

test('isIpLiteral: handles compressed and IPv4-mapped IPv6', () => {
  assert.equal(isIpLiteral('::1'), true);
  assert.equal(isIpLiteral('2001:db8::'), true);
  assert.equal(isIpLiteral('::ffff:192.0.2.128'), true);
});

test('normalizeIpLiteral: produces stable keys for equivalent IP spellings', () => {
  assert.equal(normalizeIpLiteral('203.0.113.42'), '203.0.113.42');
  assert.equal(normalizeIpLiteral('[2001:0DB8:0:0:0:0:0:1]'), '2001:db8::1');
  assert.equal(normalizeIpLiteral('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIpLiteral('::ffff:192.0.2.128'), '::ffff:c000:280');
  assert.equal(normalizeIpLiteral('not:an:ip'), null);
});

test('siteKeyForHost: ignores arbitrary subdomain depth', () => {
  assert.equal(siteKeyForHost('a.shop.example.com'), 'example.com');
  assert.equal(siteKeyForHost('cdn.mail.example.co.uk'), 'example.co.uk');
});

test('siteKeyForHost: preserves IP literals and local single-label hosts', () => {
  assert.equal(siteKeyForHost('[2001:0DB8:0:0:0:0:0:1]'), '2001:db8::1');
  assert.equal(siteKeyForHost('localhost'), 'localhost');
});

test('classifyParty: same registrable domain is first party', () => {
  assert.equal(classifyParty('img.news.example', 'news.example'), 'first');
});

test('classifyParty: different registrable domain is third party', () => {
  assert.equal(classifyParty('analytics.vendor.test', 'news.example'), 'third');
});

test('classifyParty: an IP literal is classified as ip regardless of page host', () => {
  assert.equal(classifyParty('203.0.113.42', 'news.example'), 'ip');
  assert.equal(classifyParty('203.0.113.42', 'anything.example'), 'ip');
});
