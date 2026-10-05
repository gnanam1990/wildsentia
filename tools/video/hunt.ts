/**
 * Films recorded hunts for a trailer. Watches the live feed for an hour's recorded encounters,
 * picks a hunt whose chase is still ahead, follows its predator with both animals framed (the
 * observer's own "Watch a recorded hunt"), and records from just before the chase to after
 * contact. Everything shown is the simulation's own recording.
 *
 *   npx tsx tools/video/hunt.ts <out-dir> [count=3] [fromHour=5] [toHour=9]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { LiveEncounter, LiveEncounterFrame } from '@vana/shared';

const origin = process.env.VANA_E2E_ORIGIN ?? 'http://localhost:28080';
const [out, countArg, fromArg, toArg] = process.argv.slice(2);
if (!out) throw new Error('usage: hunt.ts <out-dir> [count] [fromHour] [toHour]');
const wanted = Number(countArg ?? 3), fromHour = Number(fromArg ?? 5), toHour = Number(toArg ?? 9);
const preferred = ['tiger', 'dhole', 'jackal'];

/** The latest recorded hour, read the way the observer reads it. */
function latestFrame(): Promise<LiveEncounterFrame | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/live`);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, 20_000);
    ws.onmessage = async (message) => {
      const text = typeof message.data === 'string' ? message.data : Buffer.from(await (message.data as Blob).arrayBuffer()).toString();
      try {
        const body = JSON.parse(text) as { type?: string; frame?: LiveEncounterFrame | null };
        if (body.type === 'scene') { clearTimeout(timer); ws.close(); resolve(body.frame ?? null); }
      } catch { /* not the scene message */ }
    };
    ws.onerror = () => { clearTimeout(timer); resolve(null); };
  });
}

/** World seconds into the frame at which the chase starts, or null if it never chases. */
function chaseAt(frame: LiveEncounterFrame, e: LiveEncounter): { chase: number; end: number } | null {
  const chase = e.trace.samples.find((s) => s.phase === 'chase');
  if (!chase) return null;
  const offset = e.trace.startWorldTime - frame.startWorldTime;
  const contact = e.trace.samples.find((s) => s.phase === 'contact') ?? e.trace.samples.at(-1)!;
  return { chase: offset + chase.seconds, end: offset + contact.seconds };
}

const hourOf = (worldTime: number) => Math.floor((worldTime % 86_400) / 3600);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const cdp = await page.context().newCDPSession(page);
const filmed = new Set<string>();
let taken = 0;
while (taken < wanted) {
  const frame = await latestFrame();
  const now = frame ? frame.startWorldTime + frame.elapsedWorldSeconds : 0;
  if (!frame || hourOf(frame.startWorldTime) < fromHour || hourOf(frame.startWorldTime) >= toHour) {
    if (frame && hourOf(frame.startWorldTime) >= toHour && taken > 0) break;
    await new Promise((r) => setTimeout(r, 10_000)); continue;
  }
  // A hunt whose chase is at least 25 real seconds away, so the camera can settle first.
  const lead = 25 * frame.rate;
  const choice = frame.encounters
    .filter((e) => !filmed.has(e.eventId) && preferred.includes(e.predatorSpecies))
    .map((e) => ({ e, at: chaseAt(frame, e) }))
    .filter((c): c is { e: LiveEncounter; at: { chase: number; end: number } } => c.at !== null && c.at.chase - frame.elapsedWorldSeconds > lead)
    .sort((a, b) => (a.e.outcome === 'success' ? 0 : 1) - (b.e.outcome === 'success' ? 0 : 1)
      || preferred.indexOf(a.e.predatorSpecies) - preferred.indexOf(b.e.predatorSpecies))[0];
  if (!choice) { await new Promise((r) => setTimeout(r, 10_000)); continue; }
  const { e, at } = choice;
  filmed.add(e.eventId);
  console.log(`${e.predatorSpecies} → ${e.preySpecies} (${e.outcome}), chase in ${((at.chase - frame.elapsedWorldSeconds) / frame.rate).toFixed(0)} s`);
  await page.goto(`${origin}/?cinema=1#animal=${e.predator.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') === 'false', null, { timeout: 90_000 });
  await page.evaluate(() => {
    const quality = document.querySelector<HTMLSelectElement>('#render-quality')!;
    quality.value = 'high'; quality.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Choose the recorded hunt, as a visitor would from "Watch a recorded hunt": both animals framed.
  await page.waitForFunction((id) => [...document.querySelectorAll<HTMLOptionElement>('#live-encounter-picker option')].some((o) => o.value === id),
    e.eventId, { timeout: 60_000 });
  await page.evaluate((id) => {
    const picker = document.querySelector<HTMLSelectElement>('#live-encounter-picker')!;
    picker.value = id; picker.dispatchEvent(new Event('change', { bubbles: true }));
  }, e.eventId);
  // Lower the camera a little for a ground-level view, then wait for the chase.
  await page.mouse.move(960, 540); await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(960, 540 + 4 * i);
  await page.mouse.up();
  const startReal = Date.now() + Math.max(0, ((at.chase - frame.elapsedWorldSeconds) / frame.rate - 6)) * 1000 - 0;
  const frameSeenAt = Date.now();
  while (Date.now() < startReal) await page.waitForTimeout(200);
  const dir = join(out, `hunt-${taken + 1}-${e.predatorSpecies}-${e.preySpecies}-${e.outcome}`); mkdirSync(dir, { recursive: true });
  let n = 0, first = 0, last = 0;
  const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const ts = f.metadata.timestamp ?? 0; if (!first) first = ts; last = ts;
    writeFileSync(join(dir, `f${String(n++).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080 });
  const recordFor = Math.min(40, Math.max(14, (at.end - at.chase) / frame.rate + 16));
  await page.waitForTimeout(recordFor * 1000);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const fps = n > 1 ? (n - 1) / (last - first) : 30;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ frames: n, seconds: last - first, fps, eventId: e.eventId,
    predator: e.predator.id, prey: e.prey.id, outcome: e.outcome, chaseStartsAtSecond: 6, settledFor: (startReal - frameSeenAt) / 1000 }, null, 2));
  console.log(`  filmed ${n} frames, ${(last - first).toFixed(1)} s at ${fps.toFixed(1)} fps → ${dir}`);
  taken++;
}
await browser.close();
