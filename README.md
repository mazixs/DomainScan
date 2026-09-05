<p align="right"><b>English</b> · <a href="README.ru.md">Русский</a></p>

# DomainScan

A Chrome side panel that records every network destination the active tab contacts — hostnames,
resolved IP addresses, WebSocket handshakes — and keeps that record exact, readable and copyable.

[![CI](https://img.shields.io/github/actions/workflow/status/mazixs/DomainScan/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/mazixs/DomainScan/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mazixs/DomainScan?style=flat-square)](https://github.com/mazixs/DomainScan/releases/latest)
[![Chrome 114+](https://img.shields.io/badge/Chrome-114%2B-blue?style=flat-square)](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<p align="center">
  <img src="docs/images/panel-record.png" width="420"
       alt="DomainScan side panel for news.example: a note about possible fingerprinting marked as a heuristic, a search field, three display modes, and a list of destinations with first-party and third-party labels, request kinds, an expanded list of resolved IP addresses, an http marker and a via service worker marker.">
</p>

It is made for people who want to see where a page sends requests without being handed a scary
number. Exact evidence comes first, interpretation is always labelled as interpretation, and nothing
leaves the browser: the extension makes no network requests of its own and never collects the values
a page reads.

## What it records

- **Every destination of the active tab** — hostname or direct IP, first or third party, what kind of
  request it was, and how many times it was seen.
- **All resolved IP addresses per hostname**, not just the last one, with first and last time seen.
- **How the destination was reached** — plain `http` and `ws` are stated in the row, and so is a
  request made by the site's own service worker rather than by the page.
- **Page API use** — canvas readback, WebGL renderer, audio, timezone, language, geolocation and
  high-entropy UA hints. Only the fact of the call is recorded, never the value, and the summary is
  always labelled a heuristic.
- **One record per tab, per site.** Paths and subdomains keep accumulating; moving to another
  registrable domain starts a fresh record without touching the other tabs.

## Install

> [!NOTE]
> DomainScan is not in the Chrome Web Store yet, so it is installed unpacked.

1. Download `domainscan-vX.Y.Z.zip` from [Releases](https://github.com/mazixs/DomainScan/releases/latest)
   and unpack it, or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unpacked folder.
4. Click the DomainScan toolbar icon to open the side panel.

Chrome 114 or newer is required.

## Using it

The list fills as you browse and never rearranges itself under your hands: an open list of IP
addresses, the focused control and the scroll position survive every incoming request.

Three display modes transform the view, and none of them deletes anything:

| Subdomains folded into the parent | Grouped by registrable domain |
| --- | --- |
| <img src="docs/images/panel-subdomains.png" width="330" alt="Subdomains display mode: img.news.example is shown as news.example with the note from img.news.example under it."> | <img src="docs/images/panel-domains.png" width="330" alt="Domains display mode: hosts of one registrable domain are merged into a single row, news.example showing Document, Image and a times two counter."> |

Copy actions are separate and say what they copy: all visible domains, all visible IP addresses, or
the rows you ticked.

<img src="docs/images/panel-controls.png" width="420"
     alt="The settings menu of the panel with four actions: pause capture, stop watching browser API use, stop watching on this site, and clear this tab.">

Recording pauses per tab, and watching page API use can be switched off for one site or entirely —
page instrumentation is invisible to ordinary checks, but no instrumentation is invisible to every
bot protection, so a site that reacts badly can simply be excluded. Network recording is unaffected.

## Privacy and permissions

DomainScan calls no GeoIP, analytics or telemetry service. It observes browser events locally and
does not collect the values returned by timezone, language, location, Canvas, WebGL, audio or
User-Agent Client Hints APIs. Production code has no runtime dependencies.

| Permission | Why it is needed |
| --- | --- |
| `webRequest` | Observing request and response metadata without blocking or modifying traffic. |
| `storage` | Keeping each tab's record across service-worker suspension. |
| `sidePanel` | The panel itself. |
| `scripting` | Registering the page probe at runtime, which is what makes it switchable per site. |
| `<all_urls>` host access | Observing destinations on arbitrary sites and instrumenting their pages. |

The `tabs` permission is deliberately **not** requested: tab identifiers, activation events and the
committed tab URL that decides the current site are all available through host permissions.

## Limits worth knowing

- A resolved IP address is available only when Chrome reports one; cached responses may omit it.
- For WebSockets the opening handshake is visible, never the messages.
- An API-use signal proves a call happened. It does not prove intent, success, or that the value was
  used — which is why the panel says "possible" and never scores a site.
- A service worker's requests are recorded while a tab shows its origin; what a worker does with no
  such tab open, and what a prerendered page contacts before you open it, is not recorded rather than
  attributed to the wrong site.
- Records live in session storage: closing a tab drops its record, and closing the browser drops all
  of them.

## Development

Node.js 22 is the supported runtime.

```bash
npm ci
npm run verify                      # syntax, manifest and locale parity, generated PSL, unit tests
npx playwright install chromium
npm run test:e2e                    # loads the unpacked extension in Chromium
```

The panel can be opened outside Chrome for design work — serve the repository with
`python3 -m http.server 8080` and open `/src/sidepanel/panel.html`; it detects the missing `chrome`
API and runs on sample data with every control working.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the runtime contract: state model, attribution
  rules, messages, persistence.
- [PRODUCT.md](PRODUCT.md) — audience, purpose and the principles the interface is held to.
- [output/technical-audit.md](output/technical-audit.md) — the current audit and the platform limits
  behind the decisions (in Russian).
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — the bundled Public Suffix List and its licence.

## License

[MIT](LICENSE)
