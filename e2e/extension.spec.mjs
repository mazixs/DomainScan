import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = process.env.DOMAINSCAN_EXTENSION_PATH
  ? path.resolve(process.env.DOMAINSCAN_EXTENSION_PATH)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let server;
let port;
let context;
let profilePath;
let extensionId;

function url(host, pathname = '/') {
  return `http://${host}:${port}${pathname}`;
}

async function extensionWorker() {
  const existing = context.serviceWorkers().find((worker) =>
    worker.url().endsWith('/src/background/service-worker.js'));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', {
    predicate: (worker) => worker.url().endsWith('/src/background/service-worker.js')
  });
}

async function openPanelFor(activePage) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/panel.html`);
  await activePage.bringToFront();
  return panel;
}

function waitForWorkerStatus(cdp, runningStatus) {
  return new Promise((resolve) => {
    const listener = ({ versions }) => {
      const matched = versions.find((version) =>
        version.scriptURL.endsWith('/src/background/service-worker.js') &&
        version.runningStatus === runningStatus);
      if (!matched) return;
      cdp.off('ServiceWorker.workerVersionUpdated', listener);
      resolve(matched);
    };
    cdp.on('ServiceWorker.workerVersionUpdated', listener);
  });
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/asset') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('asset');
      return;
    }
    if (request.url === '/embedded-page') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>embedded</title><iframe src="${url('frame.vendor.test', '/minimal')}"></iframe>`);
      return;
    }

    const host = String(request.headers.host || '').split(':')[0];
    if (request.url === '/signals') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>signals</title>
        <canvas id="canvas" width="2" height="2"></canvas>
        <script>
          const canvas = document.querySelector('#canvas');
          canvas.getContext('2d').getImageData(0, 0, 1, 1);
          const gl = document.createElement('canvas').getContext('webgl');
          if (gl) gl.getParameter(gl.RENDERER);
          const Audio = window.AudioContext || window.webkitAudioContext;
          if (Audio) {
            const audio = new Audio();
            const analyser = audio.createAnalyser();
            analyser.getFloatFrequencyData(new Float32Array(analyser.frequencyBinCount));
            audio.close();
          }
          Intl.DateTimeFormat().resolvedOptions();
          void navigator.language;
          navigator.geolocation.getCurrentPosition(() => {}, () => {});
          navigator.userAgentData?.getHighEntropyValues(['architecture']);
        </script>`);
      return;
    }
    if (request.url === '/worker-sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`
        self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', (event) => {
          if (event.request.url.includes('/through-worker')) {
            event.respondWith(fetch(${JSON.stringify(url('worker.vendor.test', '/asset'))}));
          }
        });`);
      return;
    }
    if (request.url === '/worker-page') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>worker</title>
        <script>
          navigator.serviceWorker.register('/worker-sw.js')
            .then(() => navigator.serviceWorker.ready)
            .then(() => { window.__swReady = true; });
        </script>`);
      return;
    }
    if (request.url === '/deep') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>deep</title>
        <script>
          fetch(${JSON.stringify(url('img.deep.alpha.test', '/asset'))}).catch(() => {});
          fetch(${JSON.stringify(url('js.deep.alpha.test', '/asset'))}).catch(() => {});
        </script>`);
      return;
    }
    if (request.url === '/canvas-loop') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>canvas loop</title>
        <canvas id="c" width="40" height="40"></canvas>
        <script>
          const context = document.getElementById('c').getContext('2d');
          let total = 0;
          for (let i = 0; i < 6; i += 1) total += context.getImageData(0, 0, 8, 8).data.length;
          window.__read = total;
        </script>`);
      return;
    }
    if (request.url === '/beacon') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url === '/leaving') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>leaving</title>
        <script>
          addEventListener('pagehide', () => {
            navigator.sendBeacon(${JSON.stringify(url('analytics.alpha.test', '/beacon'))}, 'bye');
          });
        </script>`);
      return;
    }
    if (request.url === '/download') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="file.bin"');
      response.end('payload');
      return;
    }
    if (request.url === '/forgery') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
        <title>forgery</title>
        <script>
          window.postMessage({
            source: 'domainscan-probe',
            signal: 'geolocation'
          }, '*');
          window.dispatchEvent(new MessageEvent('domainscan:probe-channel', {
            data: { source: 'domainscan-probe' },
            ports: []
          }));
        </script>`);
      return;
    }
    const fetchHost = host.endsWith('alpha.test') ? 'cdn.alpha.test' : `cdn.${host}`;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <title>${host}</title>
      <h1>${host}</h1>
      <script>fetch(${JSON.stringify(url(fetchHost, '/asset'))}).catch(() => {});</script>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;

  profilePath = await mkdtemp(path.join(tmpdir(), 'domainscan-e2e-'));
  context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    serviceWorkers: 'allow',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP *.test 127.0.0.1, EXCLUDE localhost',
      `--unsafely-treat-insecure-origin-as-secure=${url('signals.alpha.test')},${url('pwa.alpha.test')}`,
      '--no-proxy-server'
    ]
  });
  const worker = await extensionWorker();
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  if (context) await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (profilePath) await rm(profilePath, { recursive: true, force: true });
});

test('isolates tabs, accumulates within a registrable domain, and resets across sites', async () => {
  const firstTab = context.pages()[0] || await context.newPage();
  await firstTab.goto(url('one.alpha.test'));
  const panel = await openPanelFor(firstTab);

  await expect(panel.locator('#site-host')).toHaveText('one.alpha.test');
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');

  await firstTab.goto(url('two.alpha.test', '/next'));
  await expect(panel.locator('#site-host')).toHaveText('two.alpha.test');
  await expect(panel.locator('#list')).toContainText('one.alpha.test');
  await expect(panel.locator('#list')).toContainText('two.alpha.test');

  await firstTab.goto(url('one.beta.test'));
  await expect(panel.locator('#site-host')).toHaveText('one.beta.test');
  await expect(panel.locator('#list')).not.toContainText('alpha.test');

  const secondTab = await context.newPage();
  await secondTab.goto(url('one.alpha.test'));
  await secondTab.bringToFront();
  await expect(panel.locator('#site-host')).toHaveText('one.alpha.test');
  await expect(panel.locator('#list')).not.toContainText('beta.test');

  await firstTab.bringToFront();
  await expect(panel.locator('#site-host')).toHaveText('one.beta.test');
  await expect(panel.locator('#list')).not.toContainText('alpha.test');
});

test('restores the panel connection and accumulated state after a worker restart', async () => {
  const page = await context.newPage();
  await page.goto(url('restart.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('restart.alpha.test');
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');

  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const stopped = waitForWorkerStatus(cdp, 'stopped');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await stopped;
  const running = waitForWorkerStatus(cdp, 'running');
  await page.reload();
  await running;

  await expect(panel.locator('#live-label')).toHaveText(/Recording|Идёт запись/);
  await expect(panel.locator('#site-host')).toHaveText('restart.alpha.test');
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');
});

test('copies resolved and direct IP addresses without duplicates', async () => {
  const page = await context.newPage();
  await page.goto(url('127.0.0.1'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('127.0.0.1');

  await panel.evaluate(() => {
    globalThis.__domainscanCopiedText = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text) {
          globalThis.__domainscanCopiedText = text;
        }
      }
    });
  });
  await panel.locator('#copy-ips').click();
  const clipboard = await panel.evaluate(() => globalThis.__domainscanCopiedText);
  const addresses = clipboard.split('\n').filter(Boolean);

  expect(addresses).toContain('127.0.0.1');
  expect(new Set(addresses).size).toBe(addresses.length);
});

test('collects the approved API signals from a real page without external lookups', async () => {
  const page = await context.newPage();
  await page.goto(url('signals.alpha.test', '/signals'));
  const panel = await openPanelFor(page);

  await expect(panel.locator('#signal-list > li')).toHaveCount(7);
});

test('rejects a page-forged signal and replacement channel', async () => {
  const page = await context.newPage();
  await page.goto(url('forgery.alpha.test', '/forgery'));
  const panel = await openPanelFor(page);

  await expect(panel.locator('#site-host')).toHaveText('forgery.alpha.test');
  await expect(panel.locator('#fp-note')).toBeHidden();
  await expect(panel.locator('#signal-list > li')).toHaveCount(0);
});

test('preserves same-realm native-source checks and tested error stacks', async () => {
  const page = await context.newPage();
  await page.goto(url('cloak.alpha.test'));

  const report = await page.evaluate(() => {
    const targets = {
      getImageData: CanvasRenderingContext2D.prototype.getImageData,
      toDataURL: HTMLCanvasElement.prototype.toDataURL,
      toBlob: HTMLCanvasElement.prototype.toBlob,
      webglGetParameter: WebGLRenderingContext.prototype.getParameter,
      webgl2GetParameter: WebGL2RenderingContext.prototype.getParameter,
      floatFrequencyData: AnalyserNode.prototype.getFloatFrequencyData,
      byteFrequencyData: AnalyserNode.prototype.getByteFrequencyData,
      resolvedOptions: Intl.DateTimeFormat.prototype.resolvedOptions,
      getTimezoneOffset: Date.prototype.getTimezoneOffset,
      getCurrentPosition: Geolocation.prototype.getCurrentPosition,
      watchPosition: Geolocation.prototype.watchPosition,
      languageGetter: Object.getOwnPropertyDescriptor(Navigator.prototype, 'language').get,
      languagesGetter: Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages').get,
      functionToString: Function.prototype.toString
    };
    const entries = Object.entries(targets);

    let stack = '';
    try {
      document.createElement('canvas').getContext('2d').getImageData(0, 0, 0, 0);
    } catch (error) {
      stack = String(error.stack || '');
    }

    return {
      patchedSource: entries
        .filter(([, fn]) => !Function.prototype.toString.call(fn).includes('[native code]'))
        .map(([key]) => key),
      constructable: entries
        .filter(([, fn]) => Object.getOwnPropertyNames(fn).includes('prototype'))
        .map(([key]) => key),
      stack
    };
  });

  expect(report.patchedSource).toEqual([]);
  expect(report.constructable).toEqual([]);
  expect(report.stack).not.toContain('chrome-extension://');
  await page.close();
});

test('a download from another site never becomes the site of the tab', async () => {
  const page = await context.newPage();
  await page.goto(url('shop.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('shop.alpha.test');

  const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.evaluate((target) => { window.location.href = target; },
    url('files.gamma.test', '/download'));
  await download;

  await expect(panel.locator('#site-host')).toHaveText('shop.alpha.test');
  // The request the tab really made stays visible under the site that made it.
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');
  await expect(panel.locator('#list')).toContainText('files.gamma.test');
  await page.close();
  await panel.close();
});

test('the panel states since when the record for this site is kept', async () => {
  const page = await context.newPage();
  await page.goto(url('one.alpha.test'));
  const panel = await openPanelFor(page);

  await expect(panel.locator('#record-since')).toHaveText(/\d{1,2}[:.]\d{2}/);
  await page.close();
  await panel.close();
});

test('keeps an expanded IP list and keyboard focus while new destinations arrive', async () => {
  const page = await context.newPage();
  await page.goto(url('live.alpha.test'));
  const panel = await openPanelFor(page);
  const row = panel.locator('#list li.row').filter({ hasText: 'cdn.alpha.test' });
  await expect(row).toHaveCount(1);

  await row.locator('.ip-details summary').click();
  await row.locator('.copy-btn').focus();
  await expect(row.locator('.ip-details')).toHaveJSProperty('open', true);

  // A destination arriving from the page must not disturb what the user is doing.
  await page.evaluate((target) => fetch(target).catch(() => {}), url('later.alpha.test', '/asset'));
  await expect(panel.locator('#list')).toContainText('later.alpha.test');

  await expect(row.locator('.ip-details')).toHaveJSProperty('open', true);
  expect(await panel.evaluate(() => {
    const active = document.activeElement;
    return active ? active.className : null;
  })).toContain('copy-btn');

  await page.close();
  await panel.close();
});

test('reuses the row element of a destination instead of rebuilding the list', async () => {
  const page = await context.newPage();
  await page.goto(url('stable.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');

  await panel.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#list li.row'));
    for (const row of rows) row.dataset.probe = 'marked';
  });
  await page.evaluate((target) => fetch(target).catch(() => {}), url('fresh.alpha.test', '/asset'));
  await expect(panel.locator('#list')).toContainText('fresh.alpha.test');

  expect(await panel.evaluate(
    () => document.querySelectorAll('#list li.row[data-probe="marked"]').length
  )).toBeGreaterThan(0);

  await page.close();
  await panel.close();
});

test('a destination contacted without encryption says so in its row', async () => {
  const page = await context.newPage();
  await page.goto(url('plain.alpha.test'));
  const panel = await openPanelFor(page);
  const row = panel.locator('#list li.row').filter({ hasText: 'cdn.alpha.test' });

  await expect(row.locator('.insecure')).toHaveText('http');
  await expect(row.locator('.insecure')).toHaveAttribute('title', /encryption|шифров/);
  await page.close();
  await panel.close();
});

test('the subdomain mode folds one label and names the host it folded from', async () => {
  const page = await context.newPage();
  await page.goto(url('one.deep.alpha.test', '/deep'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#list')).toContainText('img.deep.alpha.test');
  const observedHosts = await panel.locator('#list li.row').count();

  await panel.locator('.seg-btn[data-mode="collapse"]').click();
  const folded = panel.locator('#list li.row').filter({ has: panel.locator('.from', { hasText: 'img.deep.alpha.test' }) });
  await expect(folded.locator('.host')).toHaveText('deep.alpha.test');
  // Folding is a label, not a merge: every observed host still has its own row.
  await expect(panel.locator('#list li.row')).toHaveCount(observedHosts);

  // Domains mode still goes all the way to the registrable domain.
  await panel.locator('.seg-btn[data-mode="registrable"]').click();
  await expect(panel.locator('#list li.row .host').first()).toHaveText('alpha.test');
  await page.close();
  await panel.close();
});

test('a destination reached only through the site service worker is recorded', async () => {
  const page = await context.newPage();
  await page.goto(url('pwa.alpha.test', '/worker-page'));
  await page.waitForFunction(() => window.__swReady === true, null, { timeout: 15000 });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  const panel = await openPanelFor(page);

  // The page asks for its own path; only the worker's own request reaches the network.
  await page.evaluate(() => fetch('/through-worker').then((r) => r.text()).catch(() => null));

  const row = panel.locator('#list li.row').filter({ hasText: 'worker.vendor.test' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.via-worker')).toHaveAttribute('title', /service worker/i);
  await page.close();
  await panel.close();
});

test('watching page API use can be switched off and back on', async () => {
  const page = await context.newPage();
  await page.goto(url('watch.alpha.test'));
  const panel = await openPanelFor(page);

  await panel.locator('#settings-btn').click();
  await panel.locator('#toggle-apis').click();
  // Registration is disabled for fresh documents; the loaded page must be reopened.
  await expect(panel.locator('#fp-note')).toBeVisible();
  await panel.close();

  const unwatched = await context.newPage();
  await unwatched.goto(url('signals.alpha.test', '/signals'));
  expect(await unwatched.evaluate(
    () => Function.prototype.toString.call(Date.prototype.getTimezoneOffset).includes('[native code]')
  )).toBe(true);
  const unwatchedPanel = await openPanelFor(unwatched);
  await expect(unwatchedPanel.locator('#signal-list > li')).toHaveCount(0);

  await unwatchedPanel.locator('#settings-btn').click();
  await unwatchedPanel.locator('#toggle-apis').click();
  await unwatchedPanel.close();
  await unwatched.close();

  const watched = await context.newPage();
  await watched.goto(url('signals.alpha.test', '/signals'));
  const watchedPanel = await openPanelFor(watched);
  await expect(watchedPanel.locator('#signal-list > li')).toHaveCount(7);
  await watchedPanel.close();
  await watched.close();
  await page.close();
});

test('what the page being left sends on its way out stays out of the next site', async () => {
  const page = await context.newPage();
  await page.goto(url('leaving.alpha.test', '/leaving'));
  await page.goto(url('arrival.gamma.test'));
  const panel = await openPanelFor(page);

  await expect(panel.locator('#site-host')).toHaveText('arrival.gamma.test');
  await expect(panel.locator('#list')).toContainText('cdn.arrival.gamma.test');
  await expect(panel.locator('#list')).not.toContainText('analytics.alpha.test');
  await expect(panel.locator('#list')).not.toContainText('leaving.alpha.test');
  await page.close();
  await panel.close();
});

test('a page that keeps reading its canvas is warned about by Chrome, not about us', async () => {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const entries = [];
  await cdp.send('Log.enable');
  cdp.on('Log.entryAdded', ({ entry }) => entries.push(entry));

  await page.goto(url('canvas.alpha.test', '/canvas-loop'));
  await expect.poll(() => entries.some((entry) => entry.text.includes('Canvas2D'))).toBe(true);

  const panel = await openPanelFor(page);
  // The probe was installed: the first readback is what produced the signal.
  await expect(panel.locator('#signal-list > li')).toHaveCount(1);

  const framesOfExtension = entries.flatMap((entry) =>
    (entry.stackTrace ? entry.stackTrace.callFrames : [])
      .map((frame) => frame.url || '')
      .filter((frameUrl) => frameUrl.startsWith('chrome-extension://')));
  expect(framesOfExtension).toEqual([]);

  await page.close();
  await panel.close();
});

test('optional ports are displayed, searched, copied and remembered', async () => {
  const page = await context.newPage();
  await page.goto(url('ports.alpha.test'));
  const panel = await openPanelFor(page);
  await panel.setViewportSize({ width: 360, height: 800 });
  await expect(panel.locator('#site-host')).toHaveText('ports.alpha.test');
  await panel.locator('#show-ports').check();
  await expect(panel.locator('.host').filter({ hasText: `ports.alpha.test:${port}` })).toBeVisible();
  await panel.locator('#search').fill(`ports.alpha.test:${port}`);
  await expect(panel.locator('.host')).toHaveCount(1);
  await expect(panel.locator('.ip-addresses')).toContainText(`127.0.0.1:${port}`);
  await panel.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { async writeText(text) { globalThis.__domainscanCopiedText = text; } }
    });
  });
  for (const [button, expected] of [
    ['#copy-domains', `ports.alpha.test:${port}`],
    ['#copy-ips', `127.0.0.1:${port}`],
    ['.copy-btn', `ports.alpha.test:${port}`]
  ]) {
    await panel.locator(button).click();
    await expect.poll(() => panel.evaluate(() => globalThis.__domainscanCopiedText)).toBe(expected);
  }
  await panel.locator('.cb').check();
  await panel.locator('#copy-selected').click();
  await expect.poll(() => panel.evaluate(() => globalThis.__domainscanCopiedText)).toBe(`ports.alpha.test:${port}`);
  await panel.locator('.ip-details summary').click();
  await panel.screenshot({ path: 'output/playwright/ports-enabled.png', fullPage: true });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.reload();
  await page.bringToFront();
  await expect(panel.locator('#show-ports')).toBeChecked();
  await expect(panel.locator('.host').filter({ hasText: `ports.alpha.test:${port}` })).toBeVisible();
  await panel.locator('#show-ports').uncheck();
  await expect(panel.locator('.host').filter({ hasText: 'ports.alpha.test' })).toHaveText('ports.alpha.test');
});

test('domain groups reveal exact hosts and filters narrow before grouping', async () => {
  const page = await context.newPage();
  await page.goto(url('one.deep.alpha.test', '/deep'));
  const panel = await openPanelFor(page);
  await panel.setViewportSize({ width: 360, height: 800 });
  await expect(panel.locator('#list')).toContainText('img.deep.alpha.test');
  await page.evaluate((target) => fetch(target), url('cdn.vendor.test', '/asset'));
  await expect(panel.locator('#list')).toContainText('cdn.vendor.test');

  await panel.locator('.seg-btn[data-mode="registrable"]').click();
  const ownGroup = panel.locator('#list li.row').filter({ has: panel.locator('.host', { hasText: 'alpha.test' }) });
  await ownGroup.locator('.members-details summary').click();
  await expect(ownGroup.locator('.members-list')).toContainText('img.deep.alpha.test');
  await expect(ownGroup.locator('.members-list')).toContainText('js.deep.alpha.test');

  await panel.locator('#filters summary').click();
  await panel.locator('#party-filter').selectOption('third');
  await expect(panel.locator('#list li.row .host')).toHaveText(['vendor.test']);
  const vendorGroup = panel.locator('#list li.row');
  await vendorGroup.locator('.members-details summary').click();
  await expect(vendorGroup.locator('.members-list')).toContainText('cdn.vendor.test');
  await panel.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { async writeText(text) { globalThis.__domainscanCopiedText = text; } }
    });
  });
  await vendorGroup.locator('.member-copy').click();
  await expect.poll(() => panel.evaluate(() => globalThis.__domainscanCopiedText)).toBe('cdn.vendor.test');

  await panel.locator('#feature-filter').selectOption('unencrypted');
  await panel.locator('#type-filter').selectOption('fetch');
  await expect(panel.locator('#list li.row .host')).toHaveText(['vendor.test']);
  await panel.locator('#type-filter').selectOption('websocket');
  await expect(panel.locator('#list li.row')).toHaveCount(0);
  await panel.locator('#reset-filters').click();
  await expect(panel.locator('#list li.row')).not.toHaveCount(0);
  await panel.screenshot({ path: 'output/playwright/filters-and-groups.png', fullPage: true });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.close();
  await panel.close();
});

test('marker separates repeated requests from new destinations', async () => {
  const page = await context.newPage();
  await page.goto(url('marker.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');
  await panel.locator('#checkpoint-btn').click();
  await expect(panel.locator('#checkpoint-status')).toContainText(/Since|С /);
  await expect(panel.locator('#list li.row')).toHaveCount(0);

  await page.evaluate(async (targets) => {
    await Promise.all(targets.map((target) => fetch(target)));
  }, [url('cdn.alpha.test', '/asset'), url('fresh.alpha.test', '/asset')]);
  const repeated = panel.locator('#list li.row').filter({ hasText: 'cdn.alpha.test' });
  const fresh = panel.locator('#list li.row').filter({ hasText: 'fresh.alpha.test' });
  await expect(repeated.locator('.change-mark')).toContainText(/again|повтор/);
  await expect(fresh.locator('.change-mark')).toContainText(/new|новый/);
  await panel.locator('#checkpoint-btn').click();
  await expect(panel.locator('#list')).toContainText('marker.alpha.test');
  await page.close();
  await panel.close();
});

test('long histories page the visible rows without losing captured destinations', async () => {
  const page = await context.newPage();
  await page.goto(url('long.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#list')).toContainText('cdn.alpha.test');
  await page.evaluate(async (serverPort) => {
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      fetch(`http://bulk${index}.alpha.test:${serverPort}/asset`)));
  }, port);

  await expect(panel.locator('#site-count b')).toHaveText(/2\d\d/);
  await expect(panel.locator('#list li.row')).toHaveCount(200);
  await expect(panel.locator('#show-more')).toBeVisible();
  await panel.locator('#show-more').click();
  await expect(panel.locator('#list li.row')).toHaveCount(207);
  await expect(panel.locator('#show-more')).toBeHidden();
  await page.close();
  await panel.close();
});

test('clearing a record resets the marker in every open panel for that tab', async () => {
  const page = await context.newPage();
  await page.goto(url('clear.alpha.test'));
  const first = await openPanelFor(page);
  const second = await openPanelFor(page);
  await expect(second.locator('#list')).toContainText('cdn.alpha.test');
  await second.locator('#checkpoint-btn').click();
  await expect(second.locator('#checkpoint-status')).not.toHaveText('');
  await first.locator('#settings-btn').click();
  await first.locator('#clear-btn').click();
  await expect(second.locator('#checkpoint-status')).toHaveText('');
  await page.evaluate((asset) => fetch(asset), url('cdn.alpha.test', '/asset'));
  await expect(second.locator('#list')).toContainText('cdn.alpha.test');
  await Promise.all([first.close(), second.close(), page.close()]);
});

test('failed observation settings remain visible and can be retried without clipping the menu', async () => {
  const page = await context.newPage();
  await page.goto(url('settings.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('settings.alpha.test');
  const worker = await extensionWorker();
  await worker.evaluate(() => {
    globalThis.__testUnregister = chrome.scripting.unregisterContentScripts;
    chrome.scripting.unregisterContentScripts = async () => { throw new Error('test registration failure'); };
  });
  try {
    await panel.locator('#settings-btn').click();
    await panel.locator('#toggle-apis').click();
    await expect(panel.locator('#settings-error')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('settingsError_apply')));
    await panel.locator('#settings-btn').click();
    await expect(panel.locator('#toggle-apis')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('watchApisStop')));
    for (const width of [360, 420, 520]) {
      await panel.setViewportSize({ width, height: 760 });
      const bounds = await panel.locator('#settings-menu').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(760);
      expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await panel.screenshot({ path: 'output/playwright/settings-error.png' });
  } finally {
    await worker.evaluate(() => {
      chrome.scripting.unregisterContentScripts = globalThis.__testUnregister;
      delete globalThis.__testUnregister;
    });
  }
  await panel.locator('#toggle-apis').click();
  await expect(panel.locator('#settings-error')).toBeHidden();
  await panel.locator('#settings-btn').click();
  await expect(panel.locator('#toggle-apis')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('watchApisStart')));
  await panel.locator('#toggle-apis').click();
  await expect(panel.locator('#settings-error')).toBeHidden();
  await Promise.all([panel.close(), page.close()]);
});

test('an unsaved observation choice is distinguished from an unapplied one', async () => {
  const page = await context.newPage();
  await page.goto(url('unsaved.alpha.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('unsaved.alpha.test');
  const worker = await extensionWorker();
  await worker.evaluate(() => {
    globalThis.__testLocalSet = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('test storage failure'); };
  });
  try {
    await panel.locator('#settings-btn').click();
    await panel.locator('#toggle-apis').click();
    await expect(panel.locator('#settings-error')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('settingsError_save')));
    await panel.locator('#settings-btn').click();
    await expect(panel.locator('#toggle-apis')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('watchApisStart')));
  } finally {
    await worker.evaluate(() => {
      chrome.storage.local.set = globalThis.__testLocalSet;
      delete globalThis.__testLocalSet;
    });
  }
  await panel.locator('#toggle-apis').click();
  await expect(panel.locator('#settings-error')).toBeHidden();
  await Promise.all([panel.close(), page.close()]);
});

test('page API observation has cross-realm side effects while global off keeps fresh pages untouched', async () => {
  const page = await context.newPage();
  await page.goto(url('compat.alpha.test'));
  const report = await page.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const nativeSource = frame.contentWindow.Function.prototype.toString;
    try {
      const before = {
        localCheckSeesNative: Function.prototype.toString.call(Date.prototype.getTimezoneOffset).includes('[native code]'),
        cleanRealmSeesNative: nativeSource.call(Date.prototype.getTimezoneOffset).includes('[native code]')
      };
      new Date().getTimezoneOffset();
      return {
        ...before,
        dateRestoredAfterRead: nativeSource.call(Date.prototype.getTimezoneOffset).includes('[native code]'),
        toStringRemainsChanged: !nativeSource.call(Function.prototype.toString).includes('[native code]')
      };
    } finally {
      frame.remove();
    }
  });
  console.log('Observation compatibility:', JSON.stringify(report));
  expect(report).toEqual({
    localCheckSeesNative: true, cleanRealmSeesNative: false,
    dateRestoredAfterRead: true, toStringRemainsChanged: true
  });
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('compat.alpha.test');
  await panel.locator('#settings-btn').click();
  await panel.locator('#toggle-apis').click();
  await expect.poll(() => extensionWorker().then((worker) => worker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).length
  ))).toBe(0);
  await expect(panel.locator('#api-watch-help')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('apiWatchReload')));
  expect(await page.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const changed = !frame.contentWindow.Function.prototype.toString.call(Function.prototype.toString).includes('[native code]');
    frame.remove();
    return changed;
  })).toBe(true);
  expect(await (await extensionWorker()).evaluate(() => chrome.runtime.getManifest().content_scripts || [])).toEqual([]);
  const fresh = await context.newPage();
  const cdp = await context.newCDPSession(fresh);
  const executionContexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context: executionContext }) => executionContexts.push(executionContext));
  await cdp.send('Runtime.enable');
  await fresh.goto(url('compat-fresh.alpha.test'));
  expect(await fresh.evaluate(() => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const source = frame.contentWindow.Function.prototype.toString;
    const native = [Function.prototype.toString, Date.prototype.getTimezoneOffset, CanvasRenderingContext2D.prototype.getImageData]
      .every((fn) => source.call(fn).includes('[native code]'));
    frame.remove();
    return native;
  })).toBe(true);
  expect(executionContexts.filter((entry) => entry.origin === `chrome-extension://${extensionId}` || entry.name.includes(extensionId))).toEqual([]);
  await cdp.detach();
  const freshPanel = await openPanelFor(fresh);
  await expect(freshPanel.locator('#list')).toContainText('cdn.alpha.test');
  await freshPanel.locator('#settings-btn').click();
  await freshPanel.locator('#toggle-apis').click();
  await expect.poll(() => extensionWorker().then((worker) => worker.evaluate(async () =>
    (await chrome.scripting.getRegisteredContentScripts()).length
  ))).toBe(2);
  await Promise.all([panel.close(), page.close(), fresh.close(), freshPanel.close()]);
});

test('site exclusions leave third-party frames observed and explain the global off option', async () => {
  const page = await context.newPage();
  await page.goto(url('excluded.compat.test'));
  const panel = await openPanelFor(page);
  await expect(panel.locator('#site-host')).toHaveText('excluded.compat.test');
  await panel.locator('#settings-btn').click();
  await panel.locator('#toggle-site').click();
  await expect(panel.locator('#api-watch-help')).toHaveText(await panel.evaluate(() => chrome.i18n.getMessage('apiWatchSiteHelp')));
  const fresh = await context.newPage();
  await fresh.goto(url('excluded.compat.test', '/embedded-page'));
  const inspectedFrame = (frame) => frame.evaluate(() => {
    const reference = document.createElement('iframe');
    document.body.appendChild(reference);
    const source = reference.contentWindow.Function.prototype.toString;
    const native = [Function.prototype.toString, Date.prototype.getTimezoneOffset].every((fn) => source.call(fn).includes('[native code]'));
    reference.remove();
    return native;
  });
  expect(await inspectedFrame(fresh.mainFrame())).toBe(true);
  const embedded = fresh.frames().find((frame) => frame.url().includes('frame.vendor.test'));
  expect(embedded).toBeTruthy();
  expect(await inspectedFrame(embedded)).toBe(false);
  const freshPanel = await openPanelFor(fresh);
  await expect(freshPanel.locator('#site-host')).toHaveText('excluded.compat.test');
  await expect(freshPanel.locator('#list')).toContainText('frame.vendor.test');
  await freshPanel.locator('#settings-btn').click();
  await freshPanel.locator('#toggle-site').click();
  await expect(freshPanel.locator('#api-watch-help')).toBeHidden();
  await Promise.all([page.close(), panel.close(), fresh.close(), freshPanel.close()]);
});
