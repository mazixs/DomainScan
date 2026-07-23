# Reliable Tab State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DomainScan preserve per-site evidence correctly across tab activity, expose all
resolved IPs, report precise local environment signals, and release only after complete CI
verification.

**Architecture:** Pure ES modules implement domain, tab-state, signal, and panel-view behavior.
Chrome-facing files translate platform events into those modules. A single verified workflow gates
packaging and release.

**Tech Stack:** Manifest V3, browser-native ES modules, Node.js 22 test runner, Playwright Chromium,
GitHub Actions.

## Global Constraints

- Runtime behavior is fully local and performs no external request.
- Paths and subdomains of one registrable domain share a site session; a different registrable
  domain resets site-scoped evidence.
- Browser tabs never share state.
- Facts and heuristic signals remain visibly distinct, with no numeric risk score.
- Production extension code remains dependency-free and requires no build step.
- Every behavior change follows red-green-refactor and receives a focused test.

---

### Task 1: Repository baseline

**Files:**
- Modify: `.gitignore`
- Create: `docs/superpowers/specs/2026-07-24-reliable-tab-state-design.md`
- Create: `docs/superpowers/plans/2026-07-24-reliable-tab-state.md`

**Interfaces:**
- Consumes: current untracked MVP working tree
- Produces: a clean, reproducible Git baseline with no local artifacts or secrets

- [ ] **Step 1: Inspect ignored and untracked files**

Run:

```bash
git status --short --ignored
find . -path './.git' -prune -o -type f -printf '%s %p\n' | sort -nr
```

Expected: only source, documentation, icons, workflows, and tests remain candidates for tracking;
Playwright sessions and local caches are ignored.

- [ ] **Step 2: Scan candidate files for secret-shaped values**

Run:

```bash
rg --hidden -n -i --glob '!.git/**' \
  '(api[_-]?key|secret|token|password|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)' .
```

Expected: only documented GitHub secret variable names, with no credential values.

- [ ] **Step 3: Validate the baseline**

Run:

```bash
node --test
node scripts/validate.mjs
find src test scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 |
  xargs -0 -n1 node --check
git diff --check
```

Expected: 15 tests pass, validation succeeds, and every syntax/diff check exits zero.

- [ ] **Step 4: Commit and push the baseline**

```bash
git add .gitignore README.md .github CLAUDE.md PRODUCT.md _locales design-demos docs icons \
  manifest.json output product-facts.md scripts src test LICENSE
git commit -m "chore: establish reviewed DomainScan MVP baseline"
git push origin main
```

Expected: `main` and `origin/main` point to the baseline commit.

---

### Task 2: Domain, site-session, and IP state

**Files:**
- Modify: `src/lib/domain.js`
- Replace generated data: `src/lib/psl-data.js`
- Create: `src/lib/tab-state.js`
- Modify: `test/domain.test.mjs`
- Create: `test/tab-state.test.mjs`

**Interfaces:**
- Produces: `siteKeyForHost(host)`, robust `isIpLiteral(value)`, and pure tab-state transitions
- Consumed by: service worker and panel view model

- [ ] **Step 1: Add failing domain/IP tests**

Add tests asserting:

```js
assert.equal(isIpLiteral('not:an:ip'), false);
assert.equal(isIpLiteral('2001:db8::1'), true);
assert.equal(isIpLiteral('2001:db8:::1'), false);
assert.equal(siteKeyForHost('a.shop.example.co.uk'), 'example.co.uk');
assert.equal(siteKeyForHost('news.example.com'), 'example.com');
```

Run `node --test test/domain.test.mjs`.

Expected: failure because `siteKeyForHost` and strict IPv6 parsing do not exist.

- [ ] **Step 2: Implement strict IP parsing and site keys**

Implement IPv4 octet validation, IPv6 compressed/hextet validation, normalization, and
`siteKeyForHost`. Replace the curated suffix subset with generated full-list normal, wildcard, and
exception sets.

Run `node --test test/domain.test.mjs`.

Expected: all domain tests pass.

- [ ] **Step 3: Add failing site-transition and resolved-IP tests**

Cover:

```js
applyTopLevelNavigation(state, 'https://mail.example.com/inbox', now);
applyTopLevelNavigation(state, 'https://shop.example.com/cart', now + 1); // preserves evidence
applyTopLevelNavigation(state, 'https://google.test/', now + 2);          // resets evidence
recordResolvedIp(state, 'cdn.google.test', '203.0.113.10', now + 3);
recordResolvedIp(state, 'cdn.google.test', '203.0.113.11', now + 4);
```

Expected: tests fail because `src/lib/tab-state.js` does not exist.

- [ ] **Step 4: Implement minimal pure state transitions**

Create the functions listed in the design, with resolved IP objects keyed by normalized address,
origin-only `pageUrl`, preserved pause state, and deterministic normalization/reconciliation.

Run:

```bash
node --test test/domain.test.mjs test/tab-state.test.mjs
```

Expected: all domain and tab-state tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib test/domain.test.mjs test/tab-state.test.mjs
git commit -m "feat: model site sessions and resolved IP history"
```

---

### Task 3: Service-worker lifecycle and panel rebinding

**Files:**
- Refactor: `src/background/service-worker.js`
- Create: `src/background/controller.js`
- Modify: `src/common/messages.js`
- Modify: `src/sidepanel/panel.js`
- Create: `test/background-controller.test.mjs`

**Interfaces:**
- Consumes: tab-state transitions from Task 2
- Produces: `createBackgroundController(chromeApi)` and reconnecting/rebinding panel transport

- [ ] **Step 1: Add failing adapter tests**

Use a controlled fake Chrome API to assert:

```js
panelA.hello(11);
panelA.hello(12);
capture(11, 'https://one.example.com/a');
capture(12, 'https://two.example.net/b');
disconnect(panelA);
```

Verify a port receives only its currently bound tab, multiple ports can subscribe safely, pause
blocks network and heuristic capture without deleting evidence, and tab removal clears session
storage.

Run `node --test test/background-controller.test.mjs`.

Expected: failure because the injectable controller does not exist.

- [ ] **Step 2: Extract and implement the controller**

Register listeners through `createBackgroundController(chromeApi)`, maintain `Map<Port, tabId>` and
`Map<tabId, Set<Port>>`, route web requests through `tab-state.js`, and log operation-only
diagnostics on rejected storage operations.

Run `node --test test/background-controller.test.mjs`.

Expected: controller tests pass.

- [ ] **Step 3: Add panel rebind/reconnect behavior**

Implement `bindActiveTab()` using `tabs.query`, call it on `tabs.onActivated` and
`windows.onFocusChanged`, and recreate the runtime port with backoff delays of 250, 500, 1000,
2000, and at most 4000 milliseconds after disconnect.

Add a testable transport helper if browser globals otherwise prevent direct unit testing.

Run:

```bash
node --test test/background-controller.test.mjs
node scripts/validate.mjs
```

Expected: tests and manifest validation pass.

- [ ] **Step 4: Commit**

```bash
git add src/background src/common/messages.js src/sidepanel/panel.js test
git commit -m "fix: keep the panel bound to the active tab"
```

---

### Task 4: Precise environment signals and IP presentation

**Files:**
- Modify: `src/content/fingerprint-probe.js`
- Modify: `src/content/fingerprint-relay.js`
- Create: `src/lib/fingerprint.js`
- Create: `src/sidepanel/view-model.js`
- Modify: `src/sidepanel/panel.js`
- Modify: `src/sidepanel/panel.html`
- Modify: `src/sidepanel/panel.css`
- Modify: `src/common/strings.js`
- Modify: `_locales/en/messages.json`
- Modify: `_locales/ru/messages.json`
- Create: `test/fingerprint.test.mjs`
- Create: `test/panel-view-model.test.mjs`

**Interfaces:**
- Consumes: signal records and destination IP objects from Tasks 2–3
- Produces: `summarizeFingerprint(signals)` and `buildPanelRows(state, options)`

- [ ] **Step 1: Add failing signal-summary tests**

Assert that timezone alone produces environment evidence, sensitive WebGL renderer access produces
possible-fingerprinting evidence, geolocation remains separately visible, and ordinary WebGL calls
do not create a signal.

Run `node --test test/fingerprint.test.mjs`.

Expected: failure because the signal module does not exist.

- [ ] **Step 2: Implement signal definitions and summary**

Define the seven approved signal keys and pure summary derivation. Update state recording to retain
timestamps, count, and frame IDs.

Run `node --test test/fingerprint.test.mjs test/tab-state.test.mjs`.

Expected: all signal and state tests pass.

- [ ] **Step 3: Instrument approved browser APIs**

Patch only the exact methods/getters named in the design, preserve descriptors and call-through
behavior, emit each category through the relay, and keep failures isolated from the page.

Run syntax checks for both classic content scripts.

Expected: both files pass `node --check`.

- [ ] **Step 4: Add failing panel-view tests**

Assert that host rows expose every resolved IP, direct and resolved IP values deduplicate for bulk
copy, signal details use the correct localized keys, and selections are pruned when tab/site keys
change.

Run `node --test test/panel-view-model.test.mjs`.

Expected: failure because the view model does not exist.

- [ ] **Step 5: Implement the view model and accessible UI**

Render IP counts and `<details>` disclosures, derive bulk copy targets from the view model, show
signal-specific evidence, set document language from `chrome.i18n.getUILanguage()`, and localize
request types.

Run:

```bash
node --test test/fingerprint.test.mjs test/panel-view-model.test.mjs
node scripts/validate.mjs
```

Expected: tests and locale parity validation pass.

- [ ] **Step 6: Commit**

```bash
git add src _locales test
git commit -m "feat: expose IP history and precise environment signals"
```

---

### Task 5: Browser verification and release-gated CI/CD

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `test/e2e/extension.spec.mjs`
- Modify: `scripts/validate.mjs`
- Replace: `.github/workflows/ci.yml`
- Delete: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: complete runtime behavior from Tasks 2–4
- Produces: `npm test`, `npm run test:e2e`, `npm run verify`, and one gated workflow

- [ ] **Step 1: Add the Playwright development dependency and scripts**

Define:

```json
{
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:e2e": "playwright test test/e2e",
    "validate": "node scripts/validate.mjs",
    "verify": "npm run validate && npm test"
  },
  "devDependencies": {
    "@playwright/test": "latest"
  }
}
```

Run `npm install`.

Expected: a lockfile is created; production extension files remain unbundled.

- [ ] **Step 2: Write the failing unpacked-extension test**

Launch a persistent Chromium context with `--disable-extensions-except` and `--load-extension`.
Open the extension panel page and two HTTP fixtures. Assert active-tab rebinding, same-site
retention, cross-site reset, and panel recovery after terminating the extension service worker.

Run `npm run test:e2e`.

Expected: the first run exposes any remaining integration gap; fix runtime behavior rather than
weakening assertions.

- [ ] **Step 3: Build one gated workflow**

The `verify` job checks syntax, static validation, Node tests, and Playwright. `package` needs
`verify`. `release` needs `package`, runs only for a push to `main`, and creates a release only when
the manifest version is new.

Validate workflow syntax and run `npm run verify`.

Expected: no release path exists that bypasses `verify`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json test/e2e scripts/validate.mjs .github/workflows
git commit -m "ci: gate DomainScan releases on full verification"
```

---

### Task 6: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Replace: `output/technical-audit.md`
- Modify: `product-facts.md`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: final runtime and CI behavior
- Produces: accurate user, contributor, architecture, and privacy documentation

- [ ] **Step 1: Update documentation**

Document site-session boundaries, IP history, every heuristic signal and its limitations, local-only
processing, active-tab behavior, test commands, CI/release flow, and remaining Chrome platform
limitations. Remove the unused `tabs` permission.

- [ ] **Step 2: Run the complete verification matrix**

Run:

```bash
npm run verify
npm run test:e2e
find src test scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 |
  xargs -0 -n1 node --check
git diff --check
```

Expected: every command exits zero with no failed test.

- [ ] **Step 3: Package and inspect**

Package `manifest.json`, `src`, `_locales`, and `icons` into a temporary ZIP, test its integrity,
and confirm it contains no tests, dependencies, local artifacts, or secrets.

- [ ] **Step 4: Commit and publish the feature branch**

```bash
git add README.md docs output product-facts.md manifest.json
git commit -m "docs: describe reliable tab-scoped evidence"
git push -u origin mzx/reliable-tab-state
```

Expected: the branch is available remotely with a clean working tree and complete verification
evidence.
