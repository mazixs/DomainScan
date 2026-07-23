export const FINGERPRINT_SIGNALS = Object.freeze({
  canvas_readback: Object.freeze({ category: 'fingerprint', sensitive: true }),
  webgl_renderer: Object.freeze({ category: 'fingerprint', sensitive: true }),
  audio_readback: Object.freeze({ category: 'fingerprint', sensitive: true }),
  timezone: Object.freeze({ category: 'environment', sensitive: false }),
  language: Object.freeze({ category: 'environment', sensitive: false }),
  geolocation: Object.freeze({ category: 'location', sensitive: true }),
  ua_high_entropy: Object.freeze({ category: 'fingerprint', sensitive: true })
});

export function isFingerprintSignal(value) {
  return Object.hasOwn(FINGERPRINT_SIGNALS, value);
}

export function summarizeFingerprint(signals) {
  const observed = [];
  let environmentCount = 0;
  let sensitiveFingerprint = false;
  let locationRequested = false;

  for (const [key, definition] of Object.entries(FINGERPRINT_SIGNALS)) {
    const record = signals && signals[key];
    if (!record || !Number.isFinite(record.count) || record.count <= 0) continue;
    observed.push(key);
    if (definition.category === 'environment') environmentCount += 1;
    if (definition.category === 'fingerprint' && definition.sensitive) {
      sensitiveFingerprint = true;
    }
    if (definition.category === 'location') locationRequested = true;
  }

  return {
    observed,
    environmentObserved: environmentCount > 0,
    possibleFingerprinting: sensitiveFingerprint || environmentCount >= 2,
    locationRequested
  };
}
