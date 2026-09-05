# DomainScan architecture

This document is the runtime contract for the Chrome-first Manifest V3 extension.

## Runtime boundaries

Production code has no runtime dependencies and makes no DomainScan-owned network requests.
Chrome's non-blocking `webRequest` events provide request metadata and resolved IPs. Content
scripts observe a small allowlist of page API calls and send only signal names to the extension.

The extension has four layers:

1. `src/lib/`: pure normalization and immutable state transitions.
2. `src/background/controller.js`: Chrome event adapter, persistence, and subscriptions.
3. `src/content/`: MAIN-world instrumentation plus an ISOLATED-world relay. The relay is declared in
   the manifest; the MAIN-world probe is registered at runtime with `chrome.scripting`, which is what
   makes it switchable. Chrome keeps a registered script across browser restarts, so only the very
   first run after installation has a window in which a page can load before the probe exists.
4. `src/sidepanel/`: active-tab connection, derived rows, rendering, and copy actions.

The list is reconciled, never rebuilt: a destination keeps its own row element while it stays
visible, so an expanded IP list, the focused control and the scroll position survive every incoming
destination. Each part of a row is rewritten only when its own content changed.

`src/background/service-worker.js` only creates the controller with the global `chrome` object.

## Site and tab lifecycle

Each `TabState` belongs to one numeric Chrome tab ID. Its `siteKey` is:

- the normalized IP for a direct-IP top-level page;
- otherwise the registrable domain calculated with the bundled full ICANN and PRIVATE PSL.

The site of a tab is taken from the tab's own committed URL (`tabs.onUpdated`), never from a
requested navigation. Only a reported URL change counts as a commit, plus a finished load of a
document already requested in that tab, because a reload keeps the URL — a title, favicon or audio
update says nothing about where the tab is. A pending navigation belongs to one host and is consumed
only by a commit of that host. A tab that commits a non-web URL has no site, so it keeps no evidence.
Every commit replaces the document a page signal may come from. A document request only registers a pending navigation; a download, a
cancelled navigation or a failed load never becomes the site, while the document request itself
stays an observed destination of the session it was made from. When a navigation commits, the
document is recorded once, together with the IP buffered from its response.

Both `tabs.onUpdated` and the `tabs.query` seeding below use URLs granted by host permissions; the
`tabs` permission is still not requested.

A committed navigation follows these rules:

- first page: initialize the site session;
- same `siteKey`: update the visible page origin/host and retain all evidence;
- different `siteKey`: clear destinations and environment signals, retain the tab ID and pause
  preference;
- previous site unknown: evidence gathered before the site was known cannot be attributed to it, so
  it is dropped rather than shown under the wrong host.

On startup the controller rehydrates session storage and then seeds every open tab from
`tabs.query({})`, because requests observed before the first navigation of a browser session would
otherwise have no site to belong to. `siteStartedAt` records when the current site session began and
the panel states it ("Record kept since HH:MM"), so a record that starts mid-page never reads as a
complete one.

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
      requestTypes: ["script"],
      transports: ["https"],
      sources: ["page"],
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
  siteStartedAt: 1720000000000,
  updatedAt: 1720000001000
}
```

Hostnames are lower-case ASCII labels. Unicode names are normalized to Punycode. IPv4 and IPv6
literals are strictly validated and canonicalized before becoming keys. Persisted MVP records are
migrated by `normalizeTabState`.

`pageUrl` stores only the origin, not paths, queries, or fragments.

## Network observations

`onBeforeRequest` records the destination and request category, and never changes the site. A request
ID is correlated with the site sessions it was made from. `onResponseStarted` may add its normalized
IP only if the request ID, tab, hostname, and site session still match. This prevents a late response
from the previous site being attached to a new site session.

Three rules decide whether a request belongs to the site a tab is showing, and they are deliberately
strict — a record that mixes two sites is worse than a record that is short.

- A request whose `documentLifecycle` is not `active` is ignored. The page being left still fires its
  unload beacons after the next page has committed, and a prerendered page contacts destinations for a
  page nobody is looking at; both used to land under the wrong site.
- A request the top-level document makes carries that document's origin as `initiator`. When it
  disagrees with the tab's site, the commit was missed, and the request — not the stale state — decides
  the site. This is the only case where a request may change identity, and it is safe because such a
  request comes *from* the document that is loaded.
- A navigation whose request fails never becomes a site. Chrome leaves the failed address as the tab
  URL of its error page, so without this a mistyped host would wipe the record of the site the user was
  reading.

A request a service worker makes carries no tab: Chrome reports `tabId -1` even when the worker is
serving a request the page made, so on a worker-backed site most traffic would otherwise be invisible.
Such a request is attributed by its `initiator` **origin** — not its site — to every tab currently
showing that exact origin, because a worker is scoped to an origin and shared by its tabs. Its row
says so. A worker request whose origin no tab is showing (a push, a background sync, a closed tab) is
dropped rather than guessed at, and browser-internal traffic without a page origin is ignored. Each
destination keeps every way it was reached in `sources`.

One hostname retains all unique IPs with first/last timestamps and counts, and every transport it
was reached over.

The three display modes are transformations of the same evidence. **Exact** states every hostname as
observed. **Subdomains** folds one label towards the parent — never past the registrable domain,
because a public suffix alone is not a site — keeps one row per observed host, and names the host each
folded label stands for. **Domains** groups hosts of one registrable domain into a single row and says
how many were merged. Nothing is ever removed by a mode. A destination contacted over plain `http` or `ws` shows that scheme in its row, as
a fact with its explanation in the title — never as a warning or a score. The panel exposes those
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

Each signal is reported once per document, and the wrappers behind it are handed back the moment it
is reported: the page gets its own function object again, and this script leaves the call path for
good. That matters beyond speed — a page's own console warnings (`Canvas2D: Multiple readback
operations`, `WebGL: INVALID_ENUM`) carry a JS stack, and a wrapper still in place puts the extension
into it for everyone to see. Reading the unmasked WebGL renderer requires `getExtension`
(`WEBGL_debug_renderer_info`) first, so asking for that extension is taken as the same evidence, which
keeps this script out of `getParameter` — a call a render loop makes thousands of times.

Instrumentation stays indistinguishable from the untouched browser. Each wrapper is a concise
method, so it has no own `prototype` and cannot be constructed, exactly like a native built-in.
`Function.prototype.toString` is replaced once, before the first wrapper, and reports the source of
the function a wrapper replaced; the replacement reports itself as native. Errors thrown by an
instrumented API are rethrown with content-script frames removed, so a page never sees the
extension ID in a stack. This is not cosmetic: a visible wrapper makes bot protections escalate a
solvable check into a hard block, and it exposes the extension ID to any page. `e2e/extension.spec.mjs`
guards all three properties.

The ISOLATED relay registers first and accepts one synchronous `MessageChannel` from the MAIN probe
at `document_start`; later replacement channels and ordinary page `postMessage` calls are ignored.
It accepts each signal at most once per frame document and forwards nothing but the message type and
the canonical signal name. The controller drops a message from a document that is not
`active` (a back-forward-cached, prerendered or dying document is not what the tab shows), binds the
rest by document ID when Chrome supplies one, and otherwise by the tab's own top-level URL — so a
frame of any origin on the current page counts as evidence, while a message that cannot be attributed
is dropped. No value read inside
the page decides attribution. A page can still deliberately call an
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
- panel messages: `HELLO`, `SET_PAUSED`, `CLEAR`, `SET_OBSERVE_PAGE_APIS`, `SET_SITE_OBSERVED`;
- background message: `STATE`, which carries the tab state and the current settings;
- content message: `FINGERPRINT`.

Settings live in `chrome.storage.local` under `settings`: `observePageApis` and `excludedSites` (site
keys). They are loaded and applied before any page of the session is instrumented. Switching them
re-registers or unregisters the probe first and tells the panel afterwards, so the panel never claims a
page is unwatched while the probe is still there. A signal that somehow still arrives from an excluded
site or while watching is off is refused. Network observation is unaffected: only page instrumentation
is switched.

State is mirrored to `chrome.storage.session` under `tab:<id>`. Background initialization
rehydrates storage before queued browser events are applied. Writes are ordered per tab; a storage
failure is logged without blocking the live subscriber update.

Accumulation is delivered in coalesced batches: a captured destination, IP or signal marks its tab
for delivery and the whole state is written and posted once per 100 ms window, while a committed
navigation and every panel command (pause, clear) are delivered at once. A closed tab is removed
from the pending set, so a coalesced update can never resurrect it. The cost of the window is that up to
100 ms of accumulation is lost if the worker is killed in between — the panel holds the last state
delivered to it, which is behind by the same window, and the worker's own map dies with it.

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
