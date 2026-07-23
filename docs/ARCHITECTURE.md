# DomainScan — Architecture & Integration Contract

This is the **single source of truth** for how the DomainScan Chrome extension (MV3) is wired
together. Every subagent building a zone MUST read and follow this file so the parts integrate
cleanly. Do not change the shared contracts (record shape, message protocol, module APIs) — build
against them.

## Tech baseline

- Manifest V3, Chrome-first, `chrome.*` namespace, `minimum_chrome_version: 114`.
- **ES modules everywhere except content scripts.** The service worker is `type: "module"`,
  the side panel loads `panel.js` as `<script type="module">`. Content scripts CANNOT use
  `import` — they are self-contained.
- **MV3 page CSP forbids inline JS.** `panel.html` must have NO inline `<script>` and NO inline
  event handlers (`onclick=…`). All JS lives in `panel.js`. CSS may be an external file.
- No external network, no CDN, no frameworks. Everything ships in the package.

## File layout & ownership

```
manifest.json                      (foundation)
icons/                             (foundation) icon16/32/48/128.png
docs/ARCHITECTURE.md               (foundation) this file
src/
  common/
    messages.js                    (foundation) message + storage constants
    strings.js                     (foundation) t() i18n helper + English fallback dict
  lib/
    psl-data.js                    (foundation) Public Suffix List subset
    domain.js                      (foundation) pure domain logic (registrable, party, ip)
  background/
    service-worker.js              [ZONE: BACKGROUND]
  sidepanel/
    panel.html                     [ZONE: SIDE PANEL]
    panel.css                      [ZONE: SIDE PANEL]
    panel.js                       [ZONE: SIDE PANEL]
  content/
    fingerprint-probe.js           [ZONE: CONTENT]  (MAIN world, patches page APIs)
    fingerprint-relay.js           [ZONE: CONTENT]  (ISOLATED world, forwards to background)
_locales/
  en/messages.json                 (foundation)
  ru/messages.json                 [ZONE: CONTENT]  (translate en → ru)
test/
  domain.test.mjs                  [ZONE: CONTENT]  (unit tests for src/lib/domain.js)
```

Each zone owns ONLY its files. Never edit foundation files or another zone's files.

## Shared data model

A single observed destination:

```js
/**
 * @typedef {Object} Destination
 * @property {string}  id           `${kind}|${value}`  (stable key)
 * @property {'host'|'ip'} kind
 * @property {string}  value        hostname (lowercased, no trailing dot) or IP literal
 * @property {'first'|'third'|'ip'} party
 * @property {string}  requestType  'document'|'image'|'script'|'fetch'|'xhr'|'beacon'|'websocket'|'other'
 * @property {'http'|'https'|'ws'|'wss'|'other'} transport
 * @property {string|null} ip       resolved IP for a host when known (from onResponseStarted)
 * @property {number}  firstSeen    epoch ms
 * @property {number}  lastSeen     epoch ms
 * @property {number}  count        times observed
 */
```

Per-tab state (what the panel renders):

```js
/**
 * @typedef {Object} TabState
 * @property {number}  tabId
 * @property {string|null} pageUrl
 * @property {string|null} pageHost      hostname of the tab's top document
 * @property {Object.<string, Destination>} destinations   keyed by Destination.id
 * @property {{canvas:boolean, webgl:boolean, audio:boolean, firstSeen:number|null}} fingerprint
 * @property {boolean} paused
 * @property {number}  updatedAt
 */
```

## Message protocol (see src/common/messages.js)

The panel talks to the background over a **long-lived port** named `PORT_NAME`.

1. Panel: `const port = chrome.runtime.connect({ name: PORT_NAME })`, then
   `port.postMessage({ type: MSG.HELLO, tabId })` using the active tab's id.
2. Background: on connect, remembers the port + tabId, and immediately posts the current state:
   `port.postMessage({ type: MSG.STATE, state })`. It re-posts `MSG.STATE` whenever that tab's
   state changes (new destination, fingerprint signal, pause toggle, clear).
3. Panel → background control messages over the same port:
   - `{ type: MSG.SET_PAUSED, paused: boolean }`
   - `{ type: MSG.CLEAR }`   (clears the current tab's destinations)
4. Content relay → background (one-shot): `chrome.runtime.sendMessage({ type: MSG.FINGERPRINT,
   signals: { canvas?:true, webgl?:true, audio?:true } })`. Background merges signals into the
   sender tab's `fingerprint` and pushes an updated `MSG.STATE`.

Persistence: background mirrors each `TabState` into `chrome.storage.session` under `tabKey(tabId)`
so accumulation survives service-worker restarts. On startup the background rehydrates from session
storage.

## src/common/messages.js API (foundation — already written)

```js
export const PORT_NAME = 'domainscan';
export const MSG = { HELLO:'HELLO', STATE:'STATE', SET_PAUSED:'SET_PAUSED', CLEAR:'CLEAR', FINGERPRINT:'FINGERPRINT' };
export const STORAGE_PREFIX = 'tab:';
export function tabKey(tabId) { return STORAGE_PREFIX + tabId; }
```

## src/lib/domain.js API (foundation — already written)

```js
export function isIpLiteral(value): boolean          // IPv4 / IPv6 literal
export function registrableDomain(host): string      // eTLD+1 via PSL; falls back to last two labels
export function classifyParty(destValue, pageHost): 'first'|'third'|'ip'
```

- BACKGROUND uses `classifyParty(value, pageHost)` to set `Destination.party`, and `isIpLiteral`
  to set `kind`.
- SIDE PANEL uses `registrableDomain` for the "Collapse subdomains" / "Registrable domains" display
  modes and MUST classify with the same functions so first/third labelling matches the background.

## src/common/strings.js API (foundation — already written)

```js
export function t(key, substitutions?): string   // chrome.i18n.getMessage(key) || English fallback
export const FALLBACK_EN: Record<string,string>  // English strings for demo/file:// mode
```

- SIDE PANEL: import `t` and use it for EVERY user-facing string. Never hardcode display text.
- The full key list is in `_locales/en/messages.json`. `_locales/ru/messages.json` mirrors the same
  keys in Russian (ZONE: CONTENT). Do not invent new keys without adding them to en + FALLBACK_EN.

## Side-panel demo/standalone mode (REQUIRED for verification)

`panel.js` must run BOTH as a real extension page and when opened as a plain file (no `chrome`
APIs). Detect with `typeof chrome === 'undefined' || !chrome.runtime?.connect`. In that fallback
("demo mode") seed the panel with this exact sample data so the UI renders standalone:

1. news.example — document — first party
2. img.news.example — image — first party
3. static.edge.test — script — third party
4. analytics.vendor.test — fetch — third party
5. pixel.metrics.test — image beacon (requestType 'beacon') — third party
6. stream.media.test — WebSocket handshake (requestType 'websocket', transport 'wss') — third party
7. 203.0.113.42 — direct IP request (kind 'ip', party 'ip') — direct IP

pageHost = `news.example`, 18 unique total (show the 7 above), fingerprint `{canvas:true, webgl:true}`.

## Accessibility & visual contract (all UI work)

Follow the chosen design **candidate A "Simple List"** at `design-demos/candidates/01-simple-list.html`
as the visual reference. Light theme, calm, native-feeling; NO dark "cockpit" look. WCAG 2.2 AA:
keyboard operable, `:focus-visible`, `prefers-reduced-motion`, contrast ≥4.5:1, body ≥14px /
annotations ≥12px, targets ≥32px, non-color-only status. No horizontal overflow at 360/420/520px.
Distinct copy targets (domains / IPs / selected) — never one "copy all". Fingerprinting is always a
labelled heuristic, never stated as certainty.
