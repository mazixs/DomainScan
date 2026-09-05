# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What DomainScan is

A Chrome-first **Manifest V3** extension (currently **v0.2.0**) that continuously records the network
destinations observed for the active browser tab — hostnames, resolved IP addresses, WebSocket
handshake endpoints, request categories — plus a small allowlist of page API calls, and presents them
as a calm, inspectable, copyable record for **non-technical users**. Not a developer console, ad
blocker, or fear-based "security score". Audience, purpose, and brand live in `PRODUCT.md`.

Production code has **no runtime dependencies** and makes **no DomainScan-owned network requests**.
The only npm dependency is `@playwright/test` (dev-only).

## Commands

```bash
npm ci                      # Node 22 is the supported runtime
npm run verify              # syntax + validate + psl:check + unit tests — run this before committing
npm test                    # node --test test/*.test.mjs  (85 tests, 7 files)
node --test test/tab-state.test.mjs                  # single file
node --test --test-name-pattern 'registrable' test/domain.test.mjs   # single test
npm run validate            # manifest sanity, referenced files, __MSG_*__ keys, en/ru locale parity
npm run psl:check           # src/lib/psl-data.js must match the vendored PSL snapshot
node scripts/update-psl.mjs # refetch publicsuffix.org and regenerate psl-data.js (maintainer only)
npx playwright install chromium && npm run test:e2e   # loads the unpacked extension in Chromium
```

Preview the panel outside Chrome: `python3 -m http.server 8080`, then open
`http://127.0.0.1:8080/src/sidepanel/panel.html`. `panel.js` detects the absent `chrome.*` API and
runs `IS_DEMO` mode with sample data; every control works locally.

Install for manual testing: `chrome://extensions` → Developer mode → **Load unpacked** → repo root.
Chrome 114+.

## Architecture

Four layers, strictly one-directional (read `docs/ARCHITECTURE.md` — the runtime contract — before
changing anything shared):

1. **`src/lib/`** — pure functions, no `chrome` access. `domain.js` (hostname/IP normalization,
   registrable domain, party classification), `tab-state.js` (immutable `TabState` transitions),
   `fingerprint.js` (signal allowlist + summary), `psl-data.js` (10k generated lines — never edit by
   hand).
2. **`src/background/controller.js`** — the only Chrome event adapter. `createBackgroundController(chromeApi, { now, logger })`
   takes the whole `chrome` object by injection, which is why the controller is unit-testable with the
   `fakeChrome()` harness in `test/background-controller.test.mjs`. `service-worker.js` is 7 lines and
   does nothing but call it with the global `chrome`.
3. **`src/content/`** — `fingerprint-probe.js` runs in the MAIN world and preserves original
   method/getter behavior; `fingerprint-relay.js` runs in the ISOLATED world, registers first, and
   accepts exactly one synchronous `MessageChannel` at `document_start`. Only canonical signal *names*
   cross the boundary — never returned values. **The probe is registered at runtime** via
   `chrome.scripting` (`PROBE_SCRIPT_ID`), never in the manifest: moving it back would remove the
   per-site off switch that exists because no in-page instrumentation is provably invisible.
   `validate.mjs` checks the file and the `scripting` permission.
4. **`src/sidepanel/`** — `connection.js` (long-lived port, `HELLO` rebind on tab activation, bounded
   reconnect backoff), `view-model.js` (pure row derivation from `TabState`), `panel.js` (rendering,
   selection, copy, demo mode). `renderList` **reconciles by `row.key`** — never clear and rebuild the
   list, or an expanded IP list and the user's keyboard focus die on every incoming request.

**Site session model:** each `TabState` is keyed by numeric tab ID; its `siteKey` is the registrable
domain (full ICANN + PRIVATE PSL) or the normalized IP for a direct-IP top-level page. Identity comes
from the **committed** tab URL (`tabs.onUpdated`) plus `tabs.query({})` seeding at startup — never
from a `main_frame` request, because a requested navigation may be a download or be cancelled. Both
work on host permissions alone; do not add the `tabs` permission. Paths, ports,
and subdomain depth never split a session; a different `siteKey` clears evidence but keeps the tab ID
and pause preference. State is mirrored to `chrome.storage.session` under `tab:<id>`, so it survives
service-worker suspension but not tab closure. Tabs never share destination objects.

**Delivery:** `commit(state)` coalesces into a 100 ms window (`DELIVERY_INTERVAL_MS`); pass
`{ immediate: true }` only for navigation commits and panel commands. Committing per request costs
quadratic serialization — 4000 writes and 611 MB for 2000 requests, versus 11 writes and 1.6 MB.

**IP correlation:** `onBeforeRequest` records the destination and binds the request ID to the current
site session; `onResponseStarted` may attach its IP only if request ID, tab, hostname, and site
session all still match. This is deliberate — do not "simplify" it, or a late response from the
previous site lands under the new one. Each hostname retains **all** observed IPs with
first/last/count.

**Request attribution is strict by design:** ignore any request whose `documentLifecycle` is not
`active` (unload beacons of the previous page, prerender); let an `outermost_frame` request whose
`initiator` disagrees with the tab's `siteKey` correct the site (a missed commit); never let a
navigation whose request errored become the site. Loosening any of these mixes two sites in one record
— the failure users notice first.

**Service-worker traffic:** Chrome reports `tabId -1` for a request a worker makes, including when it
serves a fetch the page made — measured, not assumed. Such requests are attributed by `initiator`
**origin** (never by `siteKey`, or one site's worker would land under another of its hosts) to every
tab showing that origin, and dropped when no tab does.

**Signal attribution:** a `FINGERPRINT` message is bound to a site by document ID when Chrome supplies
one, otherwise by `sender.tab.url`; anything unattributable is dropped. The relay forwards only the
signal name — never a value read in the page.

**i18n:** `src/common/strings.js` `t(key, subs)` uses `chrome.i18n` when present and falls back to
`FALLBACK_EN`. Any new UI string needs an entry in `_locales/en/messages.json`, `_locales/ru/messages.json`,
**and** `FALLBACK_EN` — `npm run validate` fails on locale key drift.

## Repository conventions that will bite you

- **Version lives in two files.** `scripts/validate.mjs` fails unless `package.json` version equals
  `manifest.json` version. A push to `main` auto-creates release `v<version>` from that number.
- **The `tabs` permission must never be requested** — `validate.mjs` enforces this. Tab IDs and
  activation/removal events are available without it.
- **Packaging uses a strict allowlist** in `.github/workflows/ci.yml` (`verify -> package -> release`).
  A new file type or top-level directory that must ship with the extension needs both the `cp -a` list
  and the `case` allowlist updated, or CI fails the package job.
- **`src/lib/psl-data.js` is generated.** Change it only via `node scripts/update-psl.mjs`, which also
  refreshes `third_party/publicsuffix/`.
- **A wrapper lives only until its signal is reported.** `emit()` releases every wrapper of that
  signal through `rememberWrapper`, because a page's own console warnings carry a stack and anything
  still installed shows up in it. Never add a wrapper that outlives its signal.
- **MAIN-world instrumentation must stay indistinguishable.** A wrapper that reports non-native
  source, gains an own `prototype`, or leaks a `chrome-extension://` frame into a page-visible stack
  makes bot protections (Qrator, Cloudflare, DataDome) escalate to a hard 403 and exposes the
  extension ID. The `keeps page instrumentation invisible` e2e test guards this — never patch a
  native without routing it through `namedWrapper`/`conceal` in `fingerprint-probe.js`.
- Diagnostics log operation name, tab ID, and error message only — never full URLs, page values, or
  copied data.
- `output/playwright/`, `.playwright-cli/`, `.superpowers/`, `test-results/` are gitignored session
  artifacts. Tracked working docs are `docs/superpowers/plans/` and `docs/superpowers/specs/`.

## Chrome platform constraints (drive all implementation)

Verified against official docs in `product-facts.md`; re-verify with Context7 before relying on any
API detail.

- **`chrome.webRequest`** here is non-blocking observation only. It sees the **WebSocket opening
  handshake, not messages** — never build UI implying payload visibility. Resolved IPs exist only when
  Chrome supplies `onResponseStarted.details.ip`; cached responses may omit it.
- The **Side Panel API** hosts the growing destination list — not an action popup.
- **Facts vs. heuristics stay distinct in code and UI.** Observed destinations are facts; an API-use
  signal proves a call happened, not intent or success, and must always be labeled "possible".

## Non-negotiable design rules

Read `PRODUCT.md` and `design-demos/domain-scan-design-spec.md` before building or restyling UI. The
chosen direction is the **Simple List** candidate (`design-demos/candidates/01-simple-list.html`) —
keep it simple and native, no cockpit effect.

- Exact evidence is primary; interpretation is secondary and explicitly qualified. No numeric scores.
- Copy actions are **distinct and local**: copy domains, copy IP addresses, copy selected rows — never
  one ambiguous "copy everything".
- Accumulate continuously with no visual churn and no silent data loss. Display modes are display
  transformations only, never deletion: **exact** hosts as observed, **collapse** folds one label per
  row (bounded by the registrable domain) and names the host it folded from, **registrable** groups a
  domain's hosts into one row with a count.
- **WCAG 2.2 AA**: keyboard operation, visible focus, reduced motion, ≥4.5:1 text contrast,
  non-color-only status, body ≥14px / annotations ≥12px, ≥32px targets.
- Side panel viewport is 420×760; must stay usable 360–520px with no horizontal overflow and no console
  errors. Russian text expansion must not break layout.
- Explicit anti-references: cybersecurity theater, hacker-terminal styling, threat colors, fake scores,
  AI-dashboard patterns (oversized metrics, card grids, glass, gradients, decorative charts, heavy
  rounding).
- Sample and test data use documentation-only names (`*.example`, `*.test`) and reserved IPs
  (`203.0.113.x`) — never real third-party brands.
