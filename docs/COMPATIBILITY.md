# Page API observation and site compatibility

Updated: 2026-10-06. Applies to DomainScan v0.8.1.

## Exact change

Previously, `observePageApis: false` unregistered only `domainscan-page-probe` in the MAIN world.
The manifest still injected `fingerprint-relay.js` into the ISOLATED world of every matching frame.
Pausing capture suppressed recording but did not remove either script or undo page modifications.

The manifest now has no static `content_scripts`. The background dynamically registers both
`domainscan-signal-relay` and `domainscan-page-probe`, with the same site exclusions. Global API
observation off unregisters both. A fresh document receives no DomainScan page scripts in either
world, while passive domain and IP recording through `webRequest` continues.

The pair is synchronized on startup and when settings change, including migration from an older
probe-only registration. Because execution order across worlds can vary, a readiness event connects
the scripts, the MessageChannel queues early signals, and an acknowledgement removes the temporary
readiness listener. Observation enabled still changes page APIs; it is not guaranteed invisible.

## Anonymized manual result

In one manual compatibility check, a site with anti-bot protection rejected browsing with the
extension enabled. The previous API-off and capture-pause settings did not resolve the rejection;
fully disabling the extension restored access. After reloading the revised extension, globally
turning API observation off, and opening fresh site documents, no rejection was reported.
Network capture remained available in this mode.

This supports the revised mode as a compatibility option for the checked case. It does not isolate
which script, API modification, execution-world side effect, or timing difference triggered the
site protection. In particular, it does not prove that the relay alone caused the rejection.
The check does not establish long-term acceptance or compatibility with every protected site.
No site identity, account, client IP, browser profile, or browsing history is included here.

## Reproduction and automated evidence

1. Reload the extension after updating its files.
2. Globally disable page API observation in the panel; pausing capture is a separate control.
3. Close affected site tabs and open fresh ones to discard earlier injected scripts and API changes.
4. Verify that domain and IP observations continue and check site behavior.

The regression checks cover:

- startup with observation disabled removes both persisted script registrations;
- migration from a probe-only registration creates the complete pair;
- fresh documents have no static content scripts, no dynamic registrations, and no extension
  execution context when observation is globally off;
- native API source checks remain untouched in that mode and network capture continues;
- re-enabling observation restores all seven approved signal categories;
- relay-first and probe-first startup both preserve early signals without duplicate forwarding.

Site exclusions match each frame's own URL. Embedded third-party frames can still be instrumented
on an excluded top-level site; use global API observation off when a completely script-free page
is needed. Unregistering scripts affects future documents and does not undo earlier injection.
