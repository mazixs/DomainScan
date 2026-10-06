# Changelog

## [0.8.1] - 2026-10-06

### Fixed

- Globally disabling page API observation now removes both page scripts. Fresh documents receive
  no DomainScan instrumentation, while domain and IP recording continues. Previously, the isolated
  relay was still injected from the manifest. Reload the extension after updating, turn API
  observation off globally, then close and reopen affected tabs to discard earlier page changes.
- Dynamic probe and relay startup works in either execution order, preserving early API signals.
- Late IP responses cannot cross a clear, a site change, or a return to the same site.
- Capture paused during requests or navigation no longer adds those observations after resuming.
- Clearing a tab invalidates checkpoints in every open panel, including when timestamps coincide.
- Failed observation-setting changes are reported instead of appearing successful. Applied but
  unsaved settings are distinguished from changes that could not be applied.

### Performance

- Background capture uses a private per-tab accumulator instead of copying the entire destination
  dictionary for every event. Published state, storage writes, and checkpoints remain immutable.
- Domain grouping accumulates IP addresses once per group instead of repeatedly copying arrays.
- Added a reproducible synthetic CPU benchmark: `node scripts/benchmark.mjs`. These measurements
  describe local data processing, not network latency or page load speed.

### Documentation and validation

- Documented observable page API changes, fresh-tab requirements, and third-party iframe exclusions.
  An anonymized manual check reported restored site access in the revised global API-off mode;
  the triggering component and long-term acceptance are not established.
- Updated the technical audit, removed obsolete internal instructions, and anonymized historical
  compatibility examples. Documentation screenshots use reserved example domains and IPs.
- Release descriptions are extracted from this changelog and shipped with the verified ZIP.
- Verification covers 163 unit/worker tests and 25 unpacked-extension Chromium scenarios.

## [0.8.0] - 2026-09-26

- Added exact-host expansion inside grouped domains and filters applied before grouping.
- Added checkpoints for new destinations and repeated requests, including per-port changes.
- Added 200-row pagination, session-storage warnings, JSON export, and persistence-failure reporting.

## [0.7.0] - 2026-09-22

- Added optional destination-port display, search, copy, and saved presentation preference.
- Recorded URL ports with request and IP associations; these are not measured socket ports.
