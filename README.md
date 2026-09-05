# DomainScan

DomainScan is a local Chrome extension (Manifest V3) that shows the network destinations contacted
by the active browser tab. It keeps exact hostnames and IP addresses available for inspection and
copying without turning ordinary requests into a threat score.

## Current behavior

- Every browser tab has an independent history.
- Paths and subdomains of one registrable domain share that history.
- Navigating the same tab to another registrable domain starts a fresh history.
- The site of a tab comes from its committed URL, so downloads and cancelled navigations never
  replace it, while the request they made stays visible in the current record.
- Open tabs are seeded when the extension starts, and the panel states since when the record for the
  current site is kept.
- Switching tabs immediately rebinds the side panel to the selected tab.
- State survives Manifest V3 service-worker suspension through `chrome.storage.session`.
- Every observed resolved IP is retained per hostname; direct-IP requests remain visible.
- The full ICANN and PRIVATE Public Suffix List is bundled for registrable-domain decisions.
- Requests made by a site's service worker are recorded for the tabs showing that origin and marked
  as worker traffic.
- Local page instrumentation reports exact access to selected browser-environment APIs, and can be
  switched off for one site or for all of them when a site reacts badly to being instrumented.
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
- `scripting`: registers the MAIN-world probe at runtime, which is what allows switching page
  instrumentation off per site or entirely. No new page access is granted by it.
- `<all_urls>` host access: required to observe arbitrary request destinations and instrument the
  selected local APIs on pages and frames.

The extension deliberately does not request the `tabs` permission: tab identifiers, activation and
removal events, and the committed tab URLs used to decide the current site are all available through
the host permissions already granted.

## Platform limits

- Resolved IP addresses are available only when Chrome supplies `onResponseStarted.details.ip`;
  cached responses and some transport paths may omit it.
- `webRequest` observes a WebSocket opening handshake, not subsequent message payloads.
- API-use signals are evidence of access, not proof of tracking. A page can deliberately invoke
  these APIs without using the returned data, so the heuristic does not establish intent. The
  extension does not know whether a permission prompt was approved or whether a returned value was
  useful to the page.
- `chrome.storage.session` is browser-session storage. Closing a tab removes its DomainScan state.
- A prerendered page is not recorded: its requests belong to a page the tab is not showing, and there
  is no honest place to put them until it is opened.
- A service worker request is only attributable while a tab shows its origin. What a worker does with
  no such tab open — a push, a background sync — is not recorded, because there is no tab to record it
  for.
- Page instrumentation reports native sources, keeps native function shape, and strips its own
  frames from errors, so ordinary tampering checks do not see it. No in-page instrumentation can be
  proven invisible to every check, so a site behind aggressive bot protection can still react to it —
  that is what the per-site switch is for. A page already open keeps whatever instrumentation it was
  loaded with until it is reloaded.
