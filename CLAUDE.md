# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

DomainScan is a **Chrome-first, Manifest V3 browser extension** with a **working MVP (v0.1.0)**. The extension source lives under `src/` with `manifest.json` at the root; load it via `chrome://extensions` → Developer mode → Load unpacked (repo root). The original product docs, platform facts, UI spec, and design mockups (`design-demos/`) remain as reference.

- **Build:** none required — plain ES modules, no bundler, no `package.json`.
- **Test:** `node --test` (unit tests for `src/lib/domain.js`, 15 tests). `node --check <file>` for syntax.
- **Preview the panel outside Chrome:** `python3 -m http.server 8080`, then open `http://127.0.0.1:8080/src/sidepanel/panel.html` — `panel.js` runs a self-contained demo mode with sample data when `chrome.*` APIs are absent.

The binding integration contract (data model, message protocol, module APIs, file ownership) is in **`docs/ARCHITECTURE.md`** — read it before changing anything shared. Architecture overview and how-to are in `README.md`; the pre-implementation readiness audit is in `output/technical-audit.md`.

## What DomainScan is

A privacy-observation companion that continuously records the network destinations (hostnames, IP addresses, WebSocket handshake endpoints, request relationships) observed for the active browser tab, and turns them into a calm, inspectable, copyable record for **non-technical users**. It is not a developer console, ad blocker, or fear-based "security score." See `PRODUCT.md` for audience, purpose, and brand.

## Chrome platform constraints (drive all implementation)

Verified against official Chrome docs in `product-facts.md`; re-verify with Context7 / the linked docs before relying on any API detail.

- **Manifest V3 only.** Background context is an event-driven **service worker**; all executable code must be packaged with the extension.
- **`chrome.webRequest`** (non-blocking) observes/analyzes requests given the `webRequest` permission plus host permissions. It can see the **WebSocket opening handshake but not messages** after the connection is established. Do not build UI implying message payloads are visible.
- **Side Panel API** hosts the persistent, tab-aware, continuously-growing destination list — not an action popup. Configure `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so the toolbar action opens the panel directly.
- Chrome-first: use the `chrome` namespace (the `browser` alias exists from Chrome 148 but is not required).
- **Facts vs. heuristics must stay distinct in code and UI.** Observed destinations are facts; fingerprinting (Canvas/WebGL/audio/device API use) is a heuristic and must be labeled "possible," never certain.

## Non-negotiable design principles

This project has unusually strict, deliberate design rules. Read `PRODUCT.md` (principles, anti-references) and `design-demos/domain-scan-design-spec.md` before building or restyling any UI. Key constraints:

- Exact evidence is primary; interpretation is secondary and explicitly qualified.
- Copy actions are **distinct and local**: copy domains, copy IP addresses, and copy selected rows are separate targets — never one ambiguous "copy everything."
- Accumulate continuously with no visual churn and no silent data loss; display-mode changes (exact hosts / collapse subdomains / registrable domains) are display transformations only, never deletion.
- Target **WCAG 2.2 AA**: keyboard operation, visible focus, reduced motion, ≥4.5:1 text contrast, non-color-only status, body text ≥14px / annotations ≥12px, ≥32px targets.
- **Localization:** English for non-Russian locales, Russian for Russian locales; layouts must survive Russian text expansion.
- Avoid (explicit anti-references): cybersecurity theater, hacker-terminal styling, threat colors, fake scores, AI-dashboard patterns (oversized metrics, card grids, glass, gradients, decorative charts, heavy rounding).

## Repository layout

- `PRODUCT.md` — product register, users, purpose, brand personality, anti-references, design principles, accessibility.
- `product-facts.md` — verified Chrome platform facts and their design consequences, with primary-source links.
- `design-demos/domain-scan-design-spec.md` — the UI exploration brief (shared sample state, functional hierarchy, acceptance criteria).
- `design-demos/*.html` — self-contained, single-file mockups. `01`–`03` are the three competing design directions (Evidence Ledger, Network Route Monitor, Privacy Receipt); `04`–`06` explore copy/select interactions. Each fixes the side-panel viewport around **420×760** and must stay usable from 360–520px with no horizontal overflow and no console errors.
- `output/playwright/*.png` — reference screenshots of the mockups captured at the comparison viewport.
- `.superpowers/`, `.playwright-cli/` — local design/browser-review session artifacts (gitignored).

## Working with the mockups

The HTML demos are static, dependency-free, and open directly in a browser. When validating a mockup, render it at 360 / 420 / 520px widths and confirm: no horizontal overflow at 420px, no console errors, legible text at the accessibility floor, and stable rendering. Sample data uses documentation-only domains (`*.example`, `*.test`) and reserved IPs (e.g. `203.0.113.42`) — do not substitute real third-party brands or logos.
