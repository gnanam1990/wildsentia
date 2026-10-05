/**
 * Measured observer performance in real Chromium against the local stack: cold-load bytes and
 * time to a complete scene, frame times while following an animal and while exploring, and JS
 * heap over a long session. Profiles throttle CPU and network through the DevTools protocol.
 *
 *   npx tsx tools/e2e/perf.ts [--session-minutes 10] [profile ...]
 *
 * The GPU is this machine's own; CPU and network throttling cannot slow it, so frame times on
 * real low-end GPUs will be worse than these. Results land in .ci-artifacts/e2e/perf.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type BrowserContextOptions, type CDPSession, type Page } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.VANA_E2E_ORIGIN ?? 'http://localhost:28080';
const out = join(root, '.ci-artifacts', 'e2e');
mkdirSync(out, { recursive: true });

interface Profile { context: BrowserContextOptions; cpu: number; network: { down: number; up: number; latency: number } | null }
const mbit = (n: number) => n * 1_000_000 / 8;
const profiles: Record<string, Profile> = {
  desktop: { context: { viewport: { width: 1440, height: 900 } }, cpu: 1, network: null },
  'low-laptop': { context: { viewport: { width: 1366, height: 768 } }, cpu: 4, network: { down: mbit(20), up: mbit(5), latency: 40 } },
  'phone-4g': { context: { ...devices['Pixel 7'] }, cpu: 4, network: { down: mbit(9), up: mbit(1.5), latency: 150 } },
  'phone-3g': { context: { ...devices['Pixel 7'] }, cpu: 6, network: { down: mbit(1.6), up: mbit(0.75), latency: 300 } },
};

const args = process.argv.slice(2);
const minutesAt = args.indexOf('--session-minutes');
const sessionMinutes = minutesAt >= 0 ? Number(args.splice(minutesAt, 2)[1]) : 0;
const selected = args.length ? args : Object.keys(profiles);

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10 : null;
};

/** Frame-to-frame times in ms over a window, from requestAnimationFrame. */
async function frameTimes(page: Page, seconds: number): Promise<{ fps: number; p50: number | null; p95: number | null; longFrames: number }> {
  // A string, so the bundler cannot add helpers (__name) the page does not have.
  const deltas = await page.evaluate(`new Promise((done) => {
    const times = []; let last = performance.now(); const end = last + ${seconds} * 1000;
    requestAnimationFrame(function frame(now) { times.push(now - last); last = now; if (now < end) requestAnimationFrame(frame); else done(times); });
  })`) as number[];
  return { fps: Math.round(deltas.length / seconds * 10) / 10, p50: percentile(deltas, 0.5), p95: percentile(deltas, 0.95),
    longFrames: deltas.filter((d) => d > 50).length };
}

async function heapMb(cdp: CDPSession): Promise<number> {
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return Math.round(usedSize / 1e5) / 10;
}

const browser = await chromium.launch({ args: process.env.VANA_E2E_GPU_ARGS?.split(' ') ?? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results: Record<string, unknown> = {};
for (const name of selected) {
  const profile = profiles[name];
  if (!profile) { console.error(`unknown profile ${name}`); continue; }
  const context = await browser.newContext(profile.context);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.network) await cdp.send('Network.emulateNetworkConditions', { offline: false,
    downloadThroughput: profile.network.down, uploadThroughput: profile.network.up, latency: profile.network.latency });
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  let transferred = 0, requests = 0, websocketBytes = 0;
  cdp.on('Network.loadingFinished', (e) => { transferred += e.encodedDataLength; requests++; });
  cdp.on('Network.webSocketFrameReceived', (e) => { websocketBytes += e.response.payloadData.length; });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const started = Date.now();
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  const domReady = Date.now() - started;
  await page.waitForFunction(() => /\d/.test(document.querySelector('#population')?.textContent ?? ''), null, { timeout: 300_000 });
  const worldData = Date.now() - started;
  await page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') === 'false', null, { timeout: 300_000 });
  const sceneReady = Date.now() - started;
  const bytesAtScene = transferred;
  // Let lazily loaded models and near vegetation settle before measuring frames.
  await page.waitForTimeout(8000);
  const settledBytes = transferred;
  const following = await frameTimes(page, 15);
  await page.click('#freecam');
  await page.waitForTimeout(3000);
  const exploring = await frameTimes(page, 15);
  const quality = await page.evaluate(() => document.querySelector<HTMLSelectElement>('#render-quality')?.value + ' / ' +
    (document.querySelector('#render-quality-status')?.textContent ?? ''));
  const heap: number[] = [await heapMb(cdp)];
  for (let minute = 0; minute < sessionMinutes; minute++) {
    await page.waitForTimeout(60_000);
    heap.push(await heapMb(cdp));
  }
  const result = {
    profile: { cpuSlowdown: profile.cpu, network: profile.network ? `${profile.network.down * 8 / 1e6} Mbit/s, ${profile.network.latency} ms` : 'unthrottled',
      viewport: profile.context.viewport },
    load: { domReadyMs: domReady, worldDataMs: worldData, sceneReadyMs: sceneReady,
      transferredAtSceneMB: Math.round(bytesAtScene / 1e4) / 100, transferredSettledMB: Math.round(settledBytes / 1e4) / 100, requests },
    frames: { following, exploring }, quality,
    heapMB: { samples: heap, growthMB: Math.round((heap.at(-1)! - heap[0]!) * 10) / 10 },
    websocketMB: Math.round(websocketBytes / 1e4) / 100, errors,
  };
  results[name] = result;
  console.log(name, JSON.stringify(result));
  await context.close();
}
await browser.close();
writeFileSync(join(out, 'perf.json'), JSON.stringify({ origin, at: new Date().toISOString(), results }, null, 2));
