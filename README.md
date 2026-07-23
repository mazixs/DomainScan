# DomainScan

A Chrome-first (Manifest V3) browser extension that continuously records the network
destinations — hostnames, IP addresses, and WebSocket handshake endpoints — each browser tab
contacts, and turns them into a calm, inspectable, copyable record for privacy-conscious users.
It is not a developer console, an ad blocker, or a fear-based security score.

Status: **working MVP (v0.1.0).** Capture, per-tab accumulation, the side-panel UI (design
"Simple List"), distinct copy actions, a fingerprinting heuristic, and EN/RU localization are
implemented.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's root folder (the one with `manifest.json`).
4. Click the DomainScan toolbar icon to open the side panel, then browse — destinations appear live.

Requires Chrome 114+.

## Develop & verify

```bash
node --test          # run unit tests for the domain logic (15 tests)
node --check <file>  # syntax-check any source file
```

Preview the side panel outside Chrome (it runs in a self-contained demo mode with sample data):

```bash
python3 -m http.server 8080
# then open http://127.0.0.1:8080/src/sidepanel/panel.html
```

## How it works

- **`src/background/service-worker.js`** — observes requests via non-blocking `chrome.webRequest`,
  captures resolved IPs in `onResponseStarted`, accumulates per-tab state, and persists it to
  `chrome.storage.session` so it survives service-worker restarts. Talks to the panel over a
  long-lived port.
- **`src/sidepanel/`** — the side-panel UI. Wired to live data over the port; falls back to a demo
  mode when opened as a plain page.
- **`src/content/`** — a MAIN-world probe that detects (never blocks) Canvas/WebGL/audio
  fingerprinting-adjacent API use, and an ISOLATED-world relay that forwards signals to the
  background. This heuristic is always presented as "possible," never as certainty.
- **`src/lib/domain.js`** + **`src/lib/psl-data.js`** — pure, unit-tested domain logic (registrable
  domain via a Public Suffix List subset, IP detection, first/third-party classification).
- **`src/common/`**, **`_locales/`** — shared message/i18n contract and EN/RU strings.

The full integration contract is in **`docs/ARCHITECTURE.md`**. A technical readiness audit is in
**`output/technical-audit.md`**.

## Permissions

`webRequest` + `<all_urls>` host permission are required to observe destinations for arbitrary
sites (observing a sub-resource needs access to both the request URL and its initiator). The
extension only *observes* — it never blocks or modifies requests.

## Known limitations

- The bundled Public Suffix List is a curated subset; replace it with the full list from
  publicsuffix.org for complete registrable-domain accuracy in production.
- Fingerprinting detection is a heuristic based on API usage, not proof of tracking.
- IP addresses are only reliably captured for network (non-cached) responses.
