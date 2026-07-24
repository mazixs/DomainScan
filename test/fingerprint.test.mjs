import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FINGERPRINT_SIGNALS,
  isFingerprintSignal,
  summarizeFingerprint
} from '../src/lib/fingerprint.js';

function observed(...keys) {
  return Object.fromEntries(keys.map((key) => [
    key,
    { key, firstSeen: 1, lastSeen: 1, count: 1, frameIds: [0] }
  ]));
}

test('approved signal registry distinguishes environment, fingerprint, and location evidence', () => {
  assert.deepEqual(Object.keys(FINGERPRINT_SIGNALS), [
    'canvas_readback',
    'webgl_renderer',
    'audio_readback',
    'timezone',
    'language',
    'geolocation',
    'ua_high_entropy'
  ]);
  assert.equal(isFingerprintSignal('webgl_renderer'), true);
  assert.equal(isFingerprintSignal('ordinary_webgl_draw'), false);
});

test('one environment signal remains a neutral environment observation', () => {
  assert.deepEqual(summarizeFingerprint(observed('timezone')), {
    observed: ['timezone'],
    environmentObserved: true,
    possibleFingerprinting: false,
    locationRequested: false
  });
});

test('multiple environment signals produce a qualified fingerprinting possibility', () => {
  const summary = summarizeFingerprint(observed('timezone', 'language'));
  assert.equal(summary.environmentObserved, true);
  assert.equal(summary.possibleFingerprinting, true);
  assert.equal(summary.locationRequested, false);
});

test('sensitive readback and high-entropy signals produce a fingerprinting possibility', () => {
  for (const key of [
    'canvas_readback',
    'webgl_renderer',
    'audio_readback',
    'ua_high_entropy'
  ]) {
    assert.equal(summarizeFingerprint(observed(key)).possibleFingerprinting, true, key);
  }
});

test('geolocation remains a separate fact and does not imply fingerprinting by itself', () => {
  assert.deepEqual(summarizeFingerprint(observed('geolocation')), {
    observed: ['geolocation'],
    environmentObserved: false,
    possibleFingerprinting: false,
    locationRequested: true
  });
});

test('empty and malformed signal records are ignored', () => {
  assert.deepEqual(summarizeFingerprint({
    timezone: { count: 0 },
    invented: { count: 5 }
  }), {
    observed: [],
    environmentObserved: false,
    possibleFingerprinting: false,
    locationRequested: false
  });
});
