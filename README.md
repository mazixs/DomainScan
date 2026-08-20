# DomainScan

DomainScan is a local Chrome extension (Manifest V3) that shows the network destinations contacted
by the active browser tab. It keeps exact hostnames and IP addresses available for inspection and
copying without turning ordinary requests into a threat score.

## Current behavior

- Every browser tab has an independent history.
- Paths and subdomains of one registrable domain share that history.
- Navigating the same tab to another registrable domain starts a fresh history.
- Switching tabs immediately rebinds the side panel to the selected tab.
- State survives Manifest V3 service-worker suspension through `chrome.storage.session`.
- Every observed resolved IP is retained per hostname; direct-IP requests remain visible.
- The full ICANN and PRIVATE Public Suffix List is bundled for registrable-domain decisions.
- Local page instrumentation reports exact access to selected browser-environment APIs.
- English and Russian interfaces are included.

DomainScan does not call GeoIP, analytics, telemetry, or other external services. It observes
browser events and page API access locally. It does not collect the values returned by timezone,
language, location, Canvas, WebGL, audio, or User-Agent Client Hints APIs.

## Install unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository.
4. Click the DomainScan toolbar action to open the side panel.

Chrome 114 or newer is required.

## Verification

Node.js 22 is the supported development runtime.

```bash
npm ci
npm run verify
npx playwright install chromium
npm run test:e2e
```

`npm run verify` performs syntax checks, validates the manifest and locale parity, checks that the
generated PSL module matches the vendored snapshot, and runs all unit/worker tests. The Playwright
suite loads the unpacked extension in Chromium and checks tab isolation, same-site accumulation,
cross-site reset, service-worker recovery, and IP copying.

Update the vendored PSL and regenerate its runtime module with:

```bash
node scripts/update-psl.mjs
```

The source snapshot, license, and attribution are in `third_party/publicsuffix/` and
`THIRD_PARTY_NOTICES.md`.

## Architecture

- `src/lib/` contains pure domain, IP, tab-state, and signal logic.
- `src/background/controller.js` adapts Chrome events to the pure state transitions.
- `src/background/service-worker.js` is the minimal MV3 entry point.
- `src/content/` observes selected API calls locally and relays only canonical signal names.
- `src/sidepanel/` handles active-tab binding, recovery, rendering, and copying.
- `_locales/` contains matching English and Russian strings.
- `test/` contains deterministic Node tests; `e2e/` contains Chromium scenarios.

The complete state and message contract is documented in `docs/ARCHITECTURE.md`. The current audit
and remaining platform limitations are in `output/technical-audit.md`.

## Permissions

- `webRequest`: observes request and response metadata without blocking or modifying traffic.
- `storage`: preserves per-tab state across service-worker suspension.
- `sidePanel`: provides the persistent browser interface.
- `<all_urls>` host access: required to observe arbitrary request destinations and instrument the
  selected local APIs on pages and frames.

The extension deliberately does not request the `tabs` permission: the tab identifier and tab
activation/removal events used here are available without reading sensitive tab properties.

## Platform limits

- Resolved IP addresses are available only when Chrome supplies `onResponseStarted.details.ip`;
  cached responses and some transport paths may omit it.
- `webRequest` observes a WebSocket opening handshake, not subsequent message payloads.
- API-use signals are evidence of access, not proof of tracking. A page can deliberately invoke
  these APIs without using the returned data, so the heuristic does not establish intent. The
  extension does not know whether a permission prompt was approved or whether a returned value was
  useful to the page.
- `chrome.storage.session` is browser-session storage. Closing a tab removes its DomainScan state.
- Page instrumentation reports native sources, keeps native function shape, and strips its own
  frames from errors, so ordinary tampering checks do not see it. No in-page instrumentation can be
  proven invisible to every check, so a site behind aggressive bot protection can still react to it.
