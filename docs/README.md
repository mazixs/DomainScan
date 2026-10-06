# Documentation

The main [README](../README.md) and [Russian README](../README.ru.md) explain installation,
controls, privacy, and browser limitations. Release changes and update steps are in
[CHANGELOG.md](../CHANGELOG.md).

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Current state, request attribution, signals, persistence, and release pipeline |
| [Compatibility](COMPATIBILITY.md) | API observation, script-free mode, and the limits of the anonymized manual check |
| [Technical audit](TECHNICAL_AUDIT.md) | Current verification, fixed defects, reproducible measurements, and remaining limits (Russian) |
| [Platform reference](PLATFORM.md) | Dated Chrome documentation snapshot and official source links |
| [Product](../PRODUCT.md) | Audience, purpose, interface principles, and accessibility targets |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Public Suffix List attribution and licensing |
| [Historical state design](history/reliable-tab-state-design.md) | Original design from 2026-07-24; current architecture takes precedence |

The [design exploration](../design-demos/domain-scan-design-spec.md) is historical context;
the implemented Simple List reference is [the HTML candidate](../design-demos/candidates/01-simple-list.html).
Documentation examples and screenshots use reserved domains and IP addresses.

## Verification scope

Unit tests and unpacked-extension Chromium tests establish the covered local behavior. CI repeats
those checks and packages only extension runtime files plus required third-party attribution.
The release job publishes the exact verified ZIP and changelog entry. Neither successful local
checks nor CI establishes acceptance by every site's anti-bot service.

To inspect a downloaded release in the same Chromium scenarios:

```bash
DOMAINSCAN_EXTENSION_PATH=/absolute/path/to/extracted/extension npm run test:e2e
```

This loads the extracted package rather than the repository's runtime files.
