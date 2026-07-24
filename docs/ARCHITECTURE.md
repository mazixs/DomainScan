# DomainScan architecture

This document is the runtime contract for the Chrome-first Manifest V3 extension.

## Runtime boundaries

Production code has no runtime dependencies and makes no DomainScan-owned network requests.
Chrome's non-blocking `webRequest` events provide request metadata and resolved IPs. Content
scripts observe a small allowlist of page API calls and send only signal names to the extension.

The extension has four layers:

1. `src/lib/`: pure normalization and immutable state transitions.
2. `src/background/controller.js`: Chrome event adapter, persistence, and subscriptions.
3. `src/content/`: MAIN-world instrumentation plus an ISOLATED-world relay.
4. `src/sidepanel/`: active-tab connection, derived rows, rendering, and copy actions.

`src/background/service-worker.js` only creates the controller with the global `chrome` object.

## Site and tab lifecycle

Each `TabState` belongs to one numeric Chrome tab ID. Its `siteKey` is:

- the normalized IP for a direct-IP top-level page;
- otherwise the registrable domain calculated with the bundled full ICANN and PRIVATE PSL.

A main-frame navigation follows these rules:

- first page: initialize the site session;
- same `siteKey`: update the visible page origin/host and retain all evidence;
- different `siteKey`: clear destinations and environment signals, retain the tab ID and pause
  preference.

Paths, ports, and arbitrary subdomain depth do not split a site session. Closing a tab removes its
session-storage record. Tabs never share destination objects.

The panel sends `HELLO` with the active tab ID over a long-lived port. It sends another `HELLO`
after `tabs.onActivated` or a browser-window focus change. The controller atomically moves that
port between per-tab subscriber sets. On service-worker disconnect the panel reconnects with
bounded backoff (250 ms up to 4 s) and binds the current active tab again.

## State model

```js
{
  tabId: 42,
  siteKey: "example.co.uk",
  pageUrl: "https://shop.example.co.uk",
  pageHost: "shop.example.co.uk",
  destinations: {
    "host|cdn.example.co.uk": {
      id: "host|cdn.example.co.uk",
      kind: "host",
      value: "cdn.example.co.uk",
      party: "first",
      requestType: "script",
      transport: "https",
      ips: {
        "203.0.113.10": {
          value: "203.0.113.10",
          firstSeen: 1720000000000,
          lastSeen: 1720000001000,
          count: 2
        }
      },
      firstSeen: 1720000000000,
      lastSeen: 1720000001000,
      count: 2
    }
  },
  fingerprint: {
    signals: {
      timezone: {
        key: "timezone",
        firstSeen: 1720000000000,
        lastSeen: 1720000001000,
        count: 2,
        frameIds: [0]
      }
    }
  },
  paused: false,
  updatedAt: 1720000001000
}
```

Hostnames are lower-case ASCII labels. Unicode names are normalized to Punycode. IPv4 and IPv6
literals are strictly validated and canonicalized before becoming keys. Persisted MVP records are
migrated by `normalizeTabState`.

`pageUrl` stores only the origin, not paths, queries, or fragments.

## Network observations

`onBeforeRequest` records the destination and request category. A request ID is correlated with
the active site session. `onResponseStarted` may add its normalized IP only if the request ID,
tab, hostname, and site session still match. This prevents a late response from the previous site
being attached to a new site session.

One hostname retains all unique IPs with first/last timestamps and counts. The panel exposes those
addresses under the host row. “Copy IP addresses” combines visible resolved and direct IP values
and removes duplicates.

Pause suppresses new destinations, IPs, and page API signals. A main-frame navigation is still
processed while paused so the panel never displays a previous site's evidence under a new host.

## Page API evidence

The MAIN-world probe preserves original method/getter behavior and observes each category at most
once per document:

| Signal | Observed access |
|---|---|
| `canvas_readback` | `getImageData`, `toDataURL`, `toBlob` |
| `webgl_renderer` | renderer/vendor parameters through WebGL `getParameter` |
| `audio_readback` | analyser frequency data |
| `timezone` | `resolvedOptions` or `getTimezoneOffset` |
| `language` | `navigator.language` or `navigator.languages` |
| `geolocation` | `getCurrentPosition` or `watchPosition` |
| `ua_high_entropy` | `getHighEntropyValues` |

Ordinary JavaScript downloads, Canvas drawing, and WebGL rendering do not create these signals.
No returned value, coordinates, language, timezone, renderer string, audio data, or UA hint is
sent to the extension.

The ISOLATED relay registers first and accepts one synchronous `MessageChannel` from the MAIN probe
at `document_start`; later replacement channels and ordinary page `postMessage` calls are ignored.
It accepts each signal at most once per frame document, and the controller binds messages to the
current document/site when Chrome supplies document IDs. A page can still deliberately call an
instrumented API without using its result, so these signals remain heuristic evidence rather than
proof of intent.

Presentation is derived from evidence:

- one weak environment signal: neutral environment observation;
- at least two weak environment signals, or a sensitive fingerprint-related signal: possible
  fingerprinting;
- geolocation: an explicit API-call observation, not a claim that location was obtained.

These summaries can coexist in the stored model. The UI lists exact observed signal names and
never assigns a numeric risk score.

## Messages and persistence

`src/common/messages.js` defines:

- port: `domainscan`;
- panel messages: `HELLO`, `SET_PAUSED`, `CLEAR`;
- background message: `STATE`;
- content message: `FINGERPRINT`.

State is mirrored to `chrome.storage.session` under `tab:<id>`. Background initialization
rehydrates storage before queued browser events are applied. Writes are ordered per tab; a storage
failure is logged without blocking the live subscriber update.

Diagnostics include an operation name, tab ID, and error message only. They do not include full
URLs, page values, or copied data.

## Verification and delivery

- `npm test`: pure state, PSL/IP, controller, connection, view-model, and content-instrumentation
  tests.
- `npm run test:e2e`: real unpacked-extension scenarios in Playwright Chromium.
- `npm run verify`: syntax, manifest/locale, generated PSL, and Node tests.
- `.github/workflows/ci.yml`: `verify -> package -> release`.

Pull requests verify and package but never release. A push to `main` releases only after all
verification succeeds. Packaging uses an allowlist, rejects symbolic links, validates the ZIP, and
includes PSL attribution/source. Only the release job receives `contents: write`, and it downloads
the already verified artifact instead of executing repository code.
