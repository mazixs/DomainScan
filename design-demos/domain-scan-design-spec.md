# DomainScan — Three-Direction UI Exploration Specification

## Purpose

DomainScan is a Chrome-first privacy observation extension for ordinary users who want to understand which network destinations a page contacts and where information may be sent. It is not a developer console, an ad blocker, or a fear-based “security score.” The product continuously accumulates observed hostnames, IP addresses, WebSocket handshake endpoints, and relevant request relationships for the active tab. It presents evidence first and clearly labels any interpretation as a heuristic.

The immediate deliverable is three high-fidelity HTML mockups for the same primary state. They must be meaningfully different products at the composition level, not one component tree with different colors. Each direction must remain realistic for a production Chrome extension and must fit the official Chrome side panel surface.

## Audience and use context

The primary user is privacy-conscious but not necessarily technically trained. They open the side panel while browsing news, shopping, watching video, or investigating an unfamiliar site. Their attention remains divided between the webpage and a narrow companion panel. They need quick orientation first, then exact details without switching to DevTools. The interface should communicate calm competence: it may surface uncertainty and risk, but it must never imply that every third-party request is malicious.

## Output format and dimensions

- Deliver three independent, single-file HTML prototypes.
- Fixed comparison viewport: 420 × 760 CSS pixels, representing a practical Chrome side panel width and a laptop-height crop.
- The prototypes must remain usable when the width changes between 360 and 520 pixels.
- Screenshots must be captured at 420 × 760 for direct comparison.
- No external images are required. This is a tool/data interface; decorative imagery would not carry information.
- No third-party brand logos are needed or permitted. The sample data uses documentation-only domains and reserved IP addresses.

## Shared content and state

All three mockups show the same active tab and the same accumulated data:

- Active page: `news.example`
- Capture state: live, continuously accumulating
- Total unique destinations: 18
- Exact hosts visible in the primary viewport:
  - `news.example` — document, first party
  - `img.news.example` — image, first party
  - `static.edge.test` — script, third party
  - `analytics.vendor.test` — fetch, third party
  - `pixel.metrics.test` — image beacon, third party
  - `stream.media.test` — WebSocket handshake, third party
  - `203.0.113.42` — direct IP request
- A heuristic fingerprinting observation: Canvas readback and WebGL renderer queries were observed. The copy must say “possible fingerprinting” or equivalent, never claim certainty.
- Display modes: exact hosts; collapse subdomains; registrable domains.
- A compact copy-all icon action, settings access, current-site identity, destination count, and clear live state.
- Existing observations are not automatically removed while the tab session is active.

## Functional hierarchy

The first glance must answer: “Is capture running?”, “Which page am I looking at?”, and “Did anything deserve attention?” The second glance must reveal exact destination names. The third level may expose request purpose, initiator, transport, and timing. Copy-all must remain available without becoming the dominant action. Compression is a display transformation only; it must not imply deletion or data loss.

## Tone and design constraints

The product should feel observant, credible, and independent. Avoid generic cybersecurity theater, fluorescent green hacker aesthetics, Chrome-clone Material defaults, soft pastel privacy illustrations, purple gradients, glass surfaces, decorative metrics, icon-per-label systems, and repeated rounded cards. Use color primarily for semantic state and selection. Body text must be at least 14 px, annotations at least 12 px, and normal text contrast at least 4.5:1. Keyboard focus must be visible. Controls must have meaningful accessible labels and a minimum practical target size of 32 px in this dense desktop surface.

## The three independent design logics

### Direction 1 — Evidence Ledger

Time-anchor substitute for the unavailable Huashu style library: a strict Swiss editorial audit ledger. The panel reads vertically like a maintained evidence record. Use asymmetric typography, horizontal rules, row numbers or timestamps only when they carry meaning, and a restrained black/off-white/vermilion palette. Structure around a document header, a display-mode strip, and a continuous ruled list. Avoid containers around every section. Signature detail: the exact host list should feel like a printable audit record whose hierarchy survives without color.

### Direction 2 — Network Route Monitor

Reality-reference direction anchored in the causal clarity of network-monitoring tools such as Little Snitch, without copying its UI or visual assets. The panel should make initiator relationships and transport types visible. Use a warm dark field rather than generic GitHub navy, with a persistent causal rail or route spine connecting request groups. Structure must differ from Direction 1: the dominant object is a flow/timeline, not a table. Signature detail: a new destination visibly joins the route without causing layout churn.

### Direction 3 — Privacy Receipt

Unlimited-budget designer direction using Dieter Rams/Braun information-product principles: honest, understandable, unobtrusive, and thorough down to the last detail. The panel should start with a plain-language summary and progressively disclose exact evidence. It may resemble a well-typeset receipt or instrument readout, but not nostalgic skeuomorphism. Use a neutral paper/ink strategy with one purposeful signal color. Structure must differ from the other two: begin with a compact verdict-like sentence, divide destinations by understandable purpose, and keep raw hosts immediately visible rather than hidden behind a modal.

## Form derivation

- Narrative role: a live companion and evidence reader, not onboarding or marketing.
- Viewing distance: approximately 50–80 cm on a laptop, with the webpage visible beside the panel.
- Visual temperature: calm, alert, factual; never alarmist or playful.
- Capacity: seven visible destinations plus one heuristic warning must fit without shrinking text below the accessibility floor.
- Content-specific motif: a network trace that accumulates over time. Each direction must express this motif differently — ruled evidence, causal route, or itemized receipt.

## Acceptance criteria

Each prototype must be visually complete, show the shared content above, and be understandable without explanatory labels outside the panel. The three layouts must have different information architecture and visual rhythm. No prototype may rely on a card grid, a gradient, an emoji, fake scores, or filler data. Browser validation must confirm no horizontal overflow at 420 px, no console errors, legible text, and stable rendering at 360, 420, and 520 px widths.

## Verified reference basis

- [Little Snitch by Objective Development](https://www.obdev.at/products/littlesnitch/index.html) describes real-time network activity, domain hierarchies, connection relationships, protocols, and search as core network-monitoring concepts. Direction 2 transfers those information-design ideas only; it must not copy Little Snitch assets or trade dress.
- [The Design Museum overview of Dieter Rams’ principles](https://designmuseum.org/discover-design/all-stories/what-is-good-design-a-quick-look-at-dieter-rams-ten-principles) emphasizes usefulness, understandability, honesty, unobtrusiveness, durability, thoroughness, and “as little design as possible.” Direction 3 applies those principles to a privacy observation tool rather than imitating a historical Braun product.
