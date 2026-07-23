// Unit tests for src/lib/domain.js — run with: node --test test/domain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registrableDomain, isIpLiteral, classifyParty } from '../src/lib/domain.js';

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
