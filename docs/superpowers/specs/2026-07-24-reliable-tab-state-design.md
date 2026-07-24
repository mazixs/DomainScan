# DomainScan Reliable Tab State — Design

## Goal

Make DomainScan maintain correct, independent evidence for every browser tab, preserve evidence
while the user navigates within one registrable domain, reset it when the tab moves to another
registrable domain, expose every observed IP address, and report fingerprinting-adjacent API access
as precise local evidence rather than a generic warning.

## Product boundaries

- DomainScan remains fully local. It does not call GeoIP services, analytics endpoints, CDNs, or
  any other external service.
- A site's identity is its registrable domain. Paths and arbitrary subdomain depth do not split a
  session. `news.example.com` and `shop.example.com` share a session; `example.com` and
  `example.net` do not.
- Direct-IP top-level pages use the normalized IP literal as their site identity.
- Each browser tab has an independent state. Switching the active tab changes the panel binding;
  it never merges two tabs.
- Observed network destinations are facts. Page-environment access is heuristic evidence and is
  never presented as an error, attack, proof of tracking, or numeric risk score.

## Architecture

### Pure domain and state modules

`src/lib/domain.js` owns normalized host, IP validation, registrable-domain calculation, and
`siteKeyForHost(host)`. The Public Suffix List is bundled with the extension, including normal,
wildcard, and exception rules.

`src/lib/tab-state.js` owns pure state transitions:

- `makeTabState(tabId)`
- `applyTopLevelNavigation(state, url, now)`
- `recordDestination(state, observation, now)`
- `recordResolvedIp(state, host, ip, now)`
- `recordFingerprintSignal(state, signal, frameId, now)`
- `normalizeTabState(value)`

The service worker remains a Chrome API adapter: it maps browser events into these transitions,
persists the result, and publishes state to subscribed panel ports.

### Site sessions

Every `TabState` contains `siteKey`. A top-level request calculates the new key:

- no prior key: initialize the site session;
- same key: update `pageUrl` and `pageHost`, preserving destinations, IPs, and signals;
- different key: replace site-scoped evidence with an empty collection while retaining `tabId`
  and the user's paused state.

The full URL is not persisted. `pageUrl` stores only the normalized origin because the panel does
not need paths, queries, or fragments.

### Panel binding and recovery

The panel keeps one runtime port but may rebind it by sending `HELLO` with the current active tab
identifier. It re-queries and rebinds on `tabs.onActivated` and `windows.onFocusChanged`.

The background stores `port -> tabId` and `tabId -> Set<port>` relationships, so rebinding and
multiple windows are safe. On disconnect the panel retries with bounded exponential backoff and
immediately binds the active tab after reconnecting. A state message for a different tab or site
prunes UI selections from the previous view.

## Destination and IP model

A hostname destination contains an `ips` object keyed by normalized IP:

```js
{
  "203.0.113.42": {
    value: "203.0.113.42",
    firstSeen: 1720000000000,
    lastSeen: 1720000001000,
    count: 2
  }
}
```

Repeated addresses update their counters. Multiple addresses for one host are retained. Direct-IP
URLs remain destination rows and participate in bulk IP copying without duplication.

The panel shows the IP count on a host row and exposes the exact addresses through an accessible
disclosure. “Copy IP addresses” copies every visible resolved or direct IP in deterministic order.

## Environment and fingerprint signals

Signals are stored independently with `firstSeen`, `lastSeen`, `count`, and observed frame IDs:

- `canvas_readback`: `getImageData`, `toDataURL`, or `toBlob`;
- `webgl_renderer`: sensitive renderer/vendor values requested through `getParameter`;
- `audio_readback`: analyser frequency data;
- `timezone`: `Intl.DateTimeFormat().resolvedOptions()` or `Date#getTimezoneOffset`;
- `language`: reads of `navigator.language` or `navigator.languages`;
- `geolocation`: `getCurrentPosition` or `watchPosition`;
- `ua_high_entropy`: `navigator.userAgentData.getHighEntropyValues`.

The UI derives three non-exclusive summaries:

- weak environment-only evidence: “Page environment observed”;
- any sensitive fingerprint signal, or multiple environment signals: “Possible fingerprinting”;
- geolocation API use: “Location requested”.

The detail view names every observed signal. It does not claim the user's country was determined.
Ordinary JavaScript downloads and ordinary WebGL drawing do not create heuristic signals.

## Error handling and privacy

Chrome API failures are caught at listener boundaries. Development diagnostics may include the
operation name, tab ID, and error message, but never full URLs, copied values, or page content.
Storage failures do not block live updates. Connection failures produce a reconnecting state rather
than silently freezing the panel.

The broad host permission remains necessary for `webRequest` and content instrumentation. The
unused `tabs` permission is removed because tab identifiers and tab events do not require access to
sensitive tab properties.

## Verification and delivery

- Node unit tests cover domain/IP parsing, site-session transitions, resolved-IP accumulation,
  signal aggregation, persisted/live reconciliation, and panel view derivation.
- Chrome API adapter tests cover port binding/rebinding, tab cleanup, pause behavior, and storage
  calls through a controlled fake `chrome` object.
- Playwright launches the unpacked extension in Chromium and covers active-tab switching,
  same-site and cross-site navigation, service-worker reconnection, and IP-copy behavior.
- One CI workflow gates packaging and release. Release runs only on a successful verification job
  for a push to `main`, and only when the manifest version has no existing release.
- README, architecture, privacy notes, and the old technical audit are updated to describe the
  implemented behavior and remaining platform limitations.

## Execution order

1. Harden `.gitignore`, scan for secrets and generated artifacts, and create a baseline commit of
   the reviewed MVP.
2. Implement domain/session/IP behavior with test-first development.
3. Implement panel binding and service-worker recovery.
4. Implement precise environment signals and their UI.
5. Add browser-level verification and a release-gated CI/CD workflow.
6. Update documentation, run the full verification matrix, and publish the feature branch.
