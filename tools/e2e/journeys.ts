/**
 * Browser end-to-end journeys against the local stack (tools/e2e/stack.sh up). Each journey
 * drives the built observer, admin and connect pages in real Chromium, the way a visitor or
 * the operator would, and fails on page errors. Evidence lands in .ci-artifacts/e2e/.
 *
 *   npx tsx tools/e2e/journeys.ts [journey ...]
 *
 * Uses only test values: the stack's own admin token from its private env file, an unowned
 * random address as the claim wallet, and throwaway agent keys under a temporary HOME.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.VANA_E2E_ORIGIN ?? 'http://localhost:28080';
const out = join(root, '.ci-artifacts', 'e2e');
mkdirSync(out, { recursive: true });
const envFile = process.env.VANA_E2E_ENV ?? join(homedir(), '.vana-e2e.env');
const stackEnv = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n')
  .filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const adminToken = stackEnv.VANA_REWARD_ADMIN_TOKEN!;
/** A fresh, unowned test address per run (EIP-55 checksummed), so the daily wallet limit never trips reruns. */
function testWallet(): string {
  const lower = `0x00000000000000000000${randomBytes(10).toString('hex')}`.slice(2);
  const digest = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  return `0x${[...lower].map((c, i) => parseInt(digest[i]!, 16) >= 8 ? c.toUpperCase() : c).join('')}`;
}

interface Outcome { journey: string; ok: boolean; ms: number; detail: string; errors: string[] }
const outcomes: Outcome[] = [];
/** Carried from the claim journey to the admin and receipt journeys. */
let lastClaimId: string | null = null;
const claimState = join(out, 'claim-browser-state.json');

function watchErrors(page: Page, errors: string[]): void {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('response', (response) => {
    if (response.status() >= 500) errors.push(`http ${response.status()}: ${response.url()}`);
  });
}

async function admin(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

/** Opens the observer and waits until the island and its animals are on screen. */
async function openObserver(context: BrowserContext, errors: string[], hash = ''): Promise<Page> {
  const page = await context.newPage(); watchErrors(page, errors);
  await page.goto(`${origin}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#view canvas, canvas#view').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => /\d/.test(document.querySelector('#population')?.textContent ?? ''), null, { timeout: 60_000 });
  return page;
}

async function followFirst(page: Page, species: string): Promise<void> {
  await page.selectOption('#species-picker', species);
  await page.locator('#passport-panel').waitFor({ state: 'visible', timeout: 20_000 });
}

const journeys: Record<string, (browser: Browser, errors: string[]) => Promise<string>> = {
  async observer(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(out, 'observer-desktop.png') });
    const population = await page.locator('#population').textContent();
    await context.close();
    return `population chip: ${population?.trim()}`;
  },

  async mobile(browser, errors) {
    const context = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await openObserver(context, errors);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(out, 'observer-mobile.png') });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await context.close();
    if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px on a phone`);
    return 'phone layout without horizontal scroll';
  },

  async follow(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await followFirst(page, 'chital');
    await page.waitForTimeout(3000);
    const passport = (await page.locator('#passport').innerText()).slice(0, 160).replace(/\s+/g, ' ');
    await page.screenshot({ path: join(out, 'follow-chital.png') });
    await page.click('#freecam');
    await page.waitForTimeout(1500);
    await context.close();
    return `passport: ${passport}`;
  },

  async eventMap(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.click('#open-event-map');
    const dialog = page.locator('dialog[open]').first();
    await dialog.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, 'event-map.png') });
    const text = (await dialog.innerText()).slice(0, 160).replace(/\s+/g, ' ');
    await page.keyboard.press('Escape');
    await context.close();
    return `event map: ${text}`;
  },

  async community(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.click('#open-community');
    const dialog = page.locator('dialog[open]').first();
    await dialog.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, 'community.png') });
    const text = (await dialog.innerText()).slice(0, 160).replace(/\s+/g, ' ');
    await context.close();
    return `community: ${text}`;
  },

  async rewardClaim(browser, errors) {
    // The operator allocates a drop to a living animal; a visitor finds it by watching that
    // animal, reserves it through the real form, then sees it in "My reward claims".
    const animals = await (await fetch(`${origin}/api/animals`)).json() as { animals?: { id: string; speciesId: string; alive?: boolean }[] } | { id: string; speciesId: string }[];
    const list = Array.isArray(animals) ? animals : animals.animals ?? [];
    const target = list.find((a) => a.speciesId === 'chital') ?? list[0];
    if (!target) throw new Error('no living animal to allocate to');
    const dropId = crypto.randomUUID();
    await admin('/admin/rewards/drops', { id: dropId, actorId: target.id, amount: '1', revealWhen: 'watch' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors, `#animal=${target.id}`);
    const claimButton = page.locator('#reward-subject button');
    await claimButton.waitFor({ timeout: 60_000 });
    await claimButton.click();
    const dialog = page.locator('dialog.reward-dialog[open]');
    await dialog.waitFor();
    await dialog.locator('input').fill(testWallet());
    const submit = dialog.locator('button[type=submit]');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('dialog.reward-dialog[open] button[type=submit]')?.disabled,
      null, { timeout: 90_000 });
    await submit.click();
    const status = dialog.locator('[role=status]');
    await page.waitForFunction(() => /reserved|Claim /i.test(document.querySelector('dialog.reward-dialog[open] [role=status]')?.textContent ?? ''),
      null, { timeout: 20_000 });
    const result = (await status.innerText()).replace(/\s+/g, ' ');
    lastClaimId = /Claim ([0-9a-f-]{36})/.exec(result)?.[1] ?? null;
    await page.screenshot({ path: join(out, 'reward-claimed.png') });
    await context.storageState({ path: claimState });
    await dialog.locator('button', { hasText: 'Close' }).click();
    await page.click('#reward-mine');
    await page.waitForFunction(() => !/Checking…/.test(document.querySelector('dialog.reward-dialog[open]')?.textContent ?? 'Checking…'), null, { timeout: 15_000 });
    const mine = (await page.locator('dialog.reward-dialog[open]').innerText()).replace(/\s+/g, ' ').slice(0, 200);
    await context.close();
    if (!/reserved/i.test(result)) throw new Error(`claim not reserved: ${result}`);
    return `${result.slice(0, 120)} | mine: ${mine}`;
  },

  async rewardAdmin(browser, errors) {
    // The operator signs in to the admin page, sees the reserved claim and records a payment.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); watchErrors(page, errors);
    await page.goto(`${origin}/rewards-admin.html`);
    await page.fill('#admin-token', adminToken);
    await page.locator('#admin-login button[type=submit], #admin-login button').first().click();
    await page.locator('#admin-work').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1500);
    if (!lastClaimId) throw new Error('run rewardClaim first');
    const row = page.locator('#admin-claims section', { hasText: lastClaimId });
    const pay = row.locator('button', { hasText: 'Record payment without chain verification' });
    if (await pay.count() === 0) throw new Error(`claim ${lastClaimId} is not reserved in the admin ledger`);
    await pay.click();
    const review = page.locator('dialog.reward-dialog[open]');
    await review.locator('label', { hasText: 'Audit note' }).locator('input').fill('E2E test: no real transfer');
    // A syntactically valid test hash; the review records a report and moves no money.
    await review.locator('label', { hasText: 'Base transaction hash' }).locator('input').fill(`0x${randomBytes(32).toString('hex')}`);
    await review.locator('input[type=checkbox]').check();
    await review.locator('button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('dialog.reward-dialog[open]') ||
      /recorded|updated|paid/i.test(document.querySelector('dialog.reward-dialog[open] [role=status]')?.textContent ?? ''), null, { timeout: 15_000 });
    await page.click('#admin-refresh');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, 'reward-admin.png'), fullPage: true });
    const totals = (await page.locator('#admin-totals').innerText()).replace(/\s+/g, ' ');
    const rowText = (await page.locator('#admin-claims section', { hasText: lastClaimId }).innerText()).replace(/\s+/g, ' ');
    const stillPayable = await page.locator('#admin-claims section', { hasText: lastClaimId })
      .locator('button', { hasText: 'Record payment without chain verification' }).count();
    const statusText = (await page.locator('#admin-status').innerText()).replace(/\s+/g, ' ');
    await context.close();
    // This claim's own row now records the payment and no longer offers to record one.
    if (stillPayable || !/paid/i.test(rowText)) throw new Error(`claim ${lastClaimId} not recorded as paid: ${rowText}`);
    return `totals: ${totals} | status: ${statusText}`;
  },

  async rewardPaidSeen(browser, errors) {
    // Back in the visitor's browser, "My reward claims" shows the reported payment.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: claimState });
    const page = await openObserver(context, errors);
    await page.click('#reward-mine');
    await page.waitForFunction(() => /Reported transaction|Verified transaction/.test(document.querySelector('dialog.reward-dialog[open]')?.textContent ?? ''),
      null, { timeout: 15_000 });
    const text = (await page.locator('dialog.reward-dialog[open]').innerText()).replace(/\s+/g, ' ').slice(0, 220);
    await page.screenshot({ path: join(out, 'reward-paid-seen.png') });
    await context.close();
    return text;
  },

  async eventVisit(browser, errors) {
    // From the event map, a visitor flies to where an event was recorded.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.click('#open-event-map');
    const dialog = page.locator('dialog[open]').first();
    const visit = dialog.locator('button', { hasText: 'Visit event location' }).first();
    await visit.waitFor({ timeout: 30_000 });
    await visit.click();
    await page.locator('#event-visit').waitFor({ state: 'visible', timeout: 10_000 });
    const title = (await page.locator('#event-visit-title').innerText()).trim();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(out, 'event-visit.png') });
    await page.click('#event-visit-clear');
    await context.close();
    return `visited: ${title}`;
  },

  async recordedHunt(browser, errors) {
    // A recorded hunt plays on its shared timeline with both animals labelled.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.locator('details.live-encounters summary').click();
    // Hunts are sporadic and predators rest by day; at 12x a recorded world hour lasts five
    // real minutes. An hour without a hunt says so in the picker, which is the journey's answer.
    const found = await page.waitForFunction(() => {
      const picker = document.querySelector<HTMLSelectElement>('#live-encounter-picker');
      return !!picker && !picker.disabled && [...picker.options].some((o) => o.value);
    }, null, { timeout: Number(process.env.VANA_E2E_HUNT_WAIT_MS ?? 420_000) }).then(() => true, () => false);
    if (!found) {
      const shown = (await page.locator('#live-encounter-picker').innerText()).trim();
      await context.close();
      if (shown !== 'No current recordings') throw new Error(`picker neither offers a hunt nor says none: ${shown}`);
      return 'SKIP: no hunt recorded in the hours played while waiting; the picker said "No current recordings"';
    }
    const value = await page.locator('#live-encounter-picker option').evaluateAll((options) =>
      (options as HTMLOptionElement[]).find((o) => o.value)!.value);
    await page.selectOption('#live-encounter-picker', value);
    await page.locator('#live-subject-label').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(out, 'recorded-hunt.png') });
    const label = (await page.locator('#live-subject-label').innerText()).replace(/\s+/g, ' ');
    await context.close();
    return `encounter ${value}: ${label}`;
  },

  async lifeReplay(browser, errors) {
    // A followed animal's own recorded life plays back, then the visitor returns to live.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await followFirst(page, process.env.VANA_E2E_REPLAY_SPECIES ?? 'dhole');
    await page.locator('#passport button', { hasText: 'Replay this life' }).click();
    await page.locator('#replay').waitFor({ state: 'visible', timeout: 15_000 });
    const status = page.locator('#replay .replay-status');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#replay-play')?.disabled
      || /no recorded|nothing recorded|unavailable/i.test(document.querySelector('#replay .replay-status')?.textContent ?? ''), null, { timeout: 30_000 });
    const playable = !(await page.locator('#replay-play').isDisabled());
    let moved = false;
    if (playable) {
      const before = Number(await page.locator('#replay-seek').inputValue());
      await page.click('#replay-play');
      await page.waitForTimeout(4000);
      moved = Number(await page.locator('#replay-seek').inputValue()) !== before;
    }
    await page.screenshot({ path: join(out, 'life-replay.png') });
    const text = (await status.innerText()).replace(/\s+/g, ' ');
    await page.click('[data-stop-replay]');
    await page.locator('#replay').waitFor({ state: 'hidden', timeout: 10_000 });
    await context.close();
    if (playable && !moved) throw new Error(`replay did not advance: ${text}`);
    return `${playable ? 'played and advanced' : 'no recording, said so'}: ${text.slice(0, 120)}`;
  },

  async lifeHistory(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await followFirst(page, 'chital');
    await page.locator('#passport button', { hasText: 'History' }).click();
    const dialog = page.locator('dialog[open]').first();
    await dialog.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !/Loading/i.test(document.querySelector('dialog[open]')?.textContent ?? 'Loading'), null, { timeout: 20_000 });
    await page.screenshot({ path: join(out, 'life-history.png') });
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 160);
    await context.close();
    return text;
  },

  async share(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await followFirst(page, 'chital');
    await page.locator('#passport button', { hasText: 'Share' }).click();
    const dialog = page.locator('dialog[open]').first();
    await dialog.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>('#share-text')?.value ?? '').length > 0, null, { timeout: 15_000 });
    const text = await page.locator('#share-text').inputValue();
    await page.screenshot({ path: join(out, 'share.png') });
    await context.close();
    if (!/#animal=[a-z]+_[0-9a-f]+/.test(text)) throw new Error(`share story has no animal link: ${text.slice(0, 200)}`);
    return text.replace(/\s+/g, ' ').slice(0, 160);
  },

  async personHistory(browser, errors) {
    // A human birth or death on the event map opens that person's retained history.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.click('#open-event-map');
    const dialog = page.locator('dialog[open]').first();
    await dialog.waitFor();
    const filter = dialog.locator('select').first();
    const humanOptions = await filter.locator('option').evaluateAll((options) =>
      (options as HTMLOptionElement[]).filter((o) => /Human (births|deaths)/.test(o.textContent ?? '')).map((o) => o.value));
    let opened = '';
    for (const option of humanOptions) {
      await filter.selectOption(option);
      await page.waitForTimeout(1500);
      const read = dialog.locator('button', { hasText: 'Read person’s retained history' }).first();
      if (await read.count()) {
        await read.click();
        const history = page.locator('dialog[open]').last();
        await page.waitForTimeout(2000);
        opened = (await history.innerText()).replace(/\s+/g, ' ').slice(0, 160);
        await page.screenshot({ path: join(out, 'person-history.png') });
        break;
      }
    }
    await context.close();
    if (!opened) return 'no human birth or death recorded yet in this world (nothing to open)';
    return opened;
  },

  async viewOptions(browser, errors) {
    // Graphics quality and ambient audio respond, and the camera can be dragged and zoomed.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.click('#freecam');
    const canvas = page.locator('#view');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.width / 2, box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.width / 2 - 200, box.height / 2 - 80, { steps: 12 }); await page.mouse.up();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, 'explore.png') });
    await page.locator('details.observer-options summary').click();
    await page.selectOption('#render-quality', 'smooth');
    await page.waitForTimeout(800);
    const quality = (await page.locator('#render-quality-status').innerText()).trim();
    await page.click('#ambient-toggle');
    await page.waitForTimeout(800);
    const audio = (await page.locator('#ambient-toggle').innerText()).trim();
    await context.close();
    if (!/on/i.test(audio)) throw new Error(`ambient audio did not turn on: ${audio}`);
    return `quality: ${quality || '(no status)'} | ${audio}`;
  },

  async placeDrop(browser, errors) {
    // The operator scatters a drop on the island for agents; spectators see it in the list.
    const batch = await admin('/admin/rewards/place-drops', { batchId: crypto.randomUUID(), amount: '0.5', count: 1, spacingMinutes: 0, lifetimeMinutes: 5 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.waitForFunction(() => /[1-9]\d* drops?/.test(document.querySelector('#live-agents')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.click('#live-agents');
    await page.locator('#agents-list').waitFor({ state: 'visible' });
    const look = page.locator('#agents-list .drop-row button').first();
    await look.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(out, 'place-drop.png') });
    const chip = (await page.locator('#live-agents').innerText()).trim();
    await context.close();
    return `batch ${JSON.stringify(batch).slice(0, 80)} | chip: ${chip}`;
  },

  async connect(browser, errors) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); watchErrors(page, errors);
    await page.goto(`${origin}/connect.html`);
    await page.waitForFunction(() => !/Loading|Checking/i.test(document.querySelector('#connect-status')?.textContent ?? 'Loading'), null, { timeout: 15_000 });
    await page.screenshot({ path: join(out, 'connect.png'), fullPage: true });
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 200);
    await context.close();
    return text;
  },

  async liveAgent(browser, errors) {
    // An outside agent registers with its own key, takes over a chital and walks it; a
    // spectator sees it in the agents list.
    process.env.HOME = mkdtempSync(join(tmpdir(), 'vana-e2e-agent-'));
    process.env.VANA_URL = `${origin}/api`;
    process.env.VANA_PROFILE = 'e2e';
    const { api } = await import(join(root, 'packages/server/agent-client/client.mjs')) as { api: Record<string, (...args: any[]) => Promise<any>> };
    const name = `e2e-${Date.now().toString(36)}`;
    await api.register!(name, 'End-to-end test agent');
    const possessed = await api.possess!('chital');
    const me = await api.observe!();
    const x = Number(me.animal.position.x), z = Number(me.animal.position.z);
    // Walk to the first nearby spot the server can route to over land.
    let target: { x: number; z: number } | null = null;
    for (const [dx, dz] of [[15, 0], [0, 15], [-15, 0], [0, -15], [30, 30], [-30, -30]]) {
      try { await api.goTo!({ x: x + dx!, z: z + dz! }, 'walk'); target = { x: x + dx!, z: z + dz! }; break; }
      catch (error) { if ((error as Error).message !== 'no_land_route') throw error; }
    }
    if (!target) throw new Error('no land route to any nearby spot');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await openObserver(context, errors);
    await page.waitForFunction((agent) => (document.querySelector('#agents-list')?.textContent ?? '').includes(agent) ||
      (document.querySelector('#live-agents')?.textContent ?? '').includes(agent), name, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    const after = await api.observe!();
    if (Math.hypot(after.animal.position.x - x, after.animal.position.z - z) < 1) throw new Error('the steered animal did not move');
    const moved = after.animal.position;
    await page.screenshot({ path: join(out, 'live-agent.png') });
    await api.release!();
    await context.close();
    return `agent ${name} possessed ${possessed.animalId ?? JSON.stringify(possessed).slice(0, 60)}; moved from (${x.toFixed(1)}, ${z.toFixed(1)}) to (${Number(moved.x).toFixed(1)}, ${Number(moved.z).toFixed(1)})`;
  },
};

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(journeys);
const browser = await chromium.launch({
  // Real GPU rendering (Metal on macOS); software WebGL renders the island at under 1 fps.
  args: process.env.VANA_E2E_GPU_ARGS?.split(' ') ?? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
for (const name of selected) {
  const journey = journeys[name];
  if (!journey) { console.error(`unknown journey ${name}`); process.exitCode = 2; continue; }
  const errors: string[] = []; const started = Date.now();
  try {
    const detail = await journey(browser, errors);
    const ok = errors.length === 0;
    outcomes.push({ journey: name, ok, ms: Date.now() - started, detail, errors });
  } catch (error) {
    outcomes.push({ journey: name, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error), errors });
  }
  // A failed journey must not leave a rendering page behind to slow the next one.
  for (const context of browser.contexts()) await context.close().catch(() => undefined);
  const last = outcomes.at(-1)!;
  console.log(`${last.ok ? (last.detail.startsWith('SKIP') ? 'SKIP' : 'PASS') : 'FAIL'} ${name} (${(last.ms / 1000).toFixed(1)} s): ${last.detail}`);
  for (const error of last.errors.slice(0, 8)) console.log(`    ${error}`);
}
await browser.close();
writeFileSync(join(out, 'journeys.json'), JSON.stringify({ origin, at: new Date().toISOString(), outcomes }, null, 2));
if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
