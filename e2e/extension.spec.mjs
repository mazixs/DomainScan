import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      `--unsafely-treat-insecure-origin-as-secure=${url('signals.alpha.test')}`,
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

test('keeps page instrumentation invisible to native-source and stack checks', async () => {
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

  const download = page.waitForEvent('download').catch(() => null);
  await page.evaluate((target) => { window.location.href = target; },
    url('files.gamma.test', '/download'));
  await download;

  await expect(panel.locator('#site-host')).toHaveText('shop.alpha.test');
  const hosts = await panel.locator('#list .host').allInnerTexts();
  expect(hosts).toContain('cdn.alpha.test');
  expect(hosts).toContain('files.gamma.test');
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
