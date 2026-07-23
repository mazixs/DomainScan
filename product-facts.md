# DomainScan Product Facts

Verified on 2026-07-17 against the official Chrome for Developers documentation.

## Product surface

- DomainScan is a new, local Chrome extension project. No existing logo, visual identity, design system, or production UI is present in the repository.
- The primary audience is privacy-conscious general users who want to understand which hosts a page contacts and where information may be sent.

## Current Chrome platform facts

- The extension must use Manifest V3. Its background context is an event-driven service worker, and executable code must be packaged with the extension.
- `chrome.webRequest` remains available in Manifest V3 for observing and analyzing requests when the extension has the `webRequest` permission and the necessary host permissions. The blocking form is unavailable to most store-distributed extensions.
- `chrome.webRequest` can observe the WebSocket opening handshake, but not individual messages sent after the connection is established.
- The Side Panel API is available for Manifest V3 extensions and is intended for persistent companion experiences alongside a webpage. It can remain open while the user navigates and can be associated with a specific tab.
- The side panel can be opened from the extension action after `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` is configured.
- Starting with Chrome 148, extension APIs are also exposed under the `browser` namespace, but DomainScan is explicitly Chrome-first and can use the established `chrome` namespace.

## Design consequences

- A persistent, potentially long, continuously growing domain list is better represented as a tab-aware side panel than as a small transient action popup.
- The toolbar action should open the side panel directly; copying remains a compact icon action within the panel.
- The interface must distinguish observed facts from heuristic warnings. Fingerprinting detection cannot be presented as certainty merely because a page called Canvas, WebGL, audio, or device APIs.
- The UI must not imply that DomainScan can see WebSocket message payloads through `chrome.webRequest`; it can observe the handshake endpoint and may supplement this with explicitly disclosed page instrumentation where permitted.

## Primary sources

- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome Extension API reference](https://developer.chrome.com/docs/extensions/reference/api)
- [Manifest V3 overview](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Chrome Web Request API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
