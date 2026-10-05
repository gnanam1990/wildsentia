/**
 * Captures real observer footage for a trailer: 1920×1080 at the browser's frame rate, in the
 * clean view (no interface), one directory of JPEG frames per shot. Camera moves are ordinary
 * input (drag to circle a followed animal, wheel to zoom), so the footage is the product itself.
 *
 *   npx tsx tools/video/capture.ts <out-dir> [shot ...]
 *
 * Each shot directory gets frames plus meta.json with the measured frame rate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const origin = process.env.VANA_E2E_ORIGIN ?? 'http://localhost:28080';
const out = process.argv[2];
if (!out) throw new Error('usage: capture.ts <out-dir> [shot ...]');

interface Move { seconds: number; orbitPx?: number; tiltPx?: number; zoom?: number; panPx?: [number, number] }
interface Shot {
  name: string;
  /** A specific animal, or a species to pick one of (an adult at a forest edge, awake). */
  animal?: string; species?: string;
  aerial?: { zoomOut: number };
  /** Before rolling: wheel steps in (negative) or out, and how far to lower the camera (px of drag). */
  frame?: { zoom?: number; lower?: number };
  settle?: number; move: Move;
}

const shots: Shot[] = [
  { name: '01-canopy', species: 'elephant', settle: 14, frame: { lower: -120 }, move: { seconds: 9, orbitPx: 160, zoom: 3.2 } },
  { name: '02-elephant', species: 'elephant', settle: 14, frame: { zoom: -3, lower: 70 }, move: { seconds: 8, orbitPx: 220, zoom: -0.5 } },
  { name: '03-tiger', species: 'tiger', frame: { zoom: -4, lower: 80 }, move: { seconds: 8, orbitPx: -200, zoom: -0.5 } },
  { name: '04-chital', species: 'chital', frame: { zoom: -7, lower: 80 }, move: { seconds: 7, orbitPx: 180, zoom: -0.4 } },
  { name: '05-gaur', species: 'gaur', frame: { zoom: -3, lower: 80 }, move: { seconds: 7, orbitPx: -180 } },
  { name: '06-langur', species: 'langur', frame: { zoom: -7, lower: 70 }, move: { seconds: 6, orbitPx: 160, zoom: -0.3 } },
  { name: '07-dhole', species: 'dhole', frame: { zoom: -7, lower: 80 }, move: { seconds: 7, orbitPx: -170, zoom: -0.4 } },
  { name: '08-boar', species: 'boar', frame: { zoom: -7, lower: 80 }, move: { seconds: 6, orbitPx: 150, zoom: -0.3 } },
  { name: '09-squirrel', species: 'squirrel', frame: { zoom: -7, lower: 70 }, move: { seconds: 6, orbitPx: -150 } },
  { name: '10-sambar', species: 'sambar', frame: { zoom: -3, lower: 80 }, move: { seconds: 6, orbitPx: 160 } },
  { name: '11-vulture', species: 'vulture', frame: { zoom: -3, lower: 60 }, move: { seconds: 7, orbitPx: -160 } },
  { name: '12-pullback', species: 'gaur', frame: { lower: 40 }, move: { seconds: 10, orbitPx: 120, tiltPx: -80, zoom: 3.4 } },
];

interface Patch { id: number; canopyCover: number; surface?: string }
interface Animal { id: string; speciesId: string; patchId: number; state: string; lifeStage?: string; dependent?: boolean }
/** An awake adult of the species standing where forest meets open ground, for a good backdrop. */
async function pick(species: string): Promise<string> {
  const [{ animals }, patchBody] = await Promise.all([
    fetch(`${origin}/api/animals`).then((r) => r.json()) as Promise<{ animals: Animal[] }>,
    fetch(`${origin}/api/patches`).then((r) => r.json()) as Promise<Patch[] | { patches: Patch[] }>,
  ]);
  const patches = new Map((Array.isArray(patchBody) ? patchBody : patchBody.patches).map((p) => [p.id, p]));
  const score = (a: Animal) => {
    const canopy = patches.get(a.patchId)?.canopyCover ?? 0;
    return (a.state === 'resting' ? -2 : 0) + (a.dependent ? -1 : 0) - Math.abs(canopy - 0.5) * 3;
  };
  const candidates = animals.filter((a) => a.speciesId === species).sort((a, b) => score(b) - score(a));
  if (!candidates.length) throw new Error(`no living ${species}`);
  return candidates[0]!.id;
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${origin}/?cinema=1${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') === 'false', null, { timeout: 90_000 });
  // The control is hidden in the clean view; set it as the page's own handler expects.
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#render-quality')!;
    select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Smooth input over `seconds`: a drag for orbit/tilt/pan, small wheel steps for zoom. */
async function perform(page: Page, move: Move): Promise<void> {
  const steps = Math.round(move.seconds * 30);
  const cx = 960, cy = 540;
  const drag = (move.orbitPx ?? 0) !== 0 || (move.tiltPx ?? 0) !== 0 || move.panPx !== undefined;
  const [dx, dy] = move.panPx ?? [-(move.orbitPx ?? 0), move.tiltPx ?? 0];
  if (drag) { await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + Math.sign(dx || 1) * 8, cy); }
  for (let i = 1; i <= steps; i++) {
    // Ease in and out so every shot starts and ends still.
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    if (drag) await page.mouse.move(cx + Math.sign(dx || 1) * 8 + dx * e, cy + dy * e);
    if (move.zoom) await page.mouse.wheel(0, (move.zoom * 833) / steps);
    await page.waitForTimeout(1000 / 30);
  }
  if (drag) await page.mouse.up();
}

const wanted = new Set(process.argv.slice(3));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const cdp = await page.context().newCDPSession(page);
for (const shot of shots) {
  if (wanted.size && !wanted.has(shot.name)) continue;
  const dir = join(out, shot.name); mkdirSync(dir, { recursive: true });
  const animal = shot.animal ?? (shot.species ? await pick(shot.species) : undefined);
  await open(page, animal ? `#animal=${animal}` : '');
  if (shot.aerial) {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#freecam')!.click());
    await page.mouse.move(960, 540);
    for (let i = 0; i < shot.aerial.zoomOut; i++) { await page.mouse.wheel(0, 400); await page.waitForTimeout(60); }
  }
  // Let models, near vegetation and the follow flight settle, then frame the shot.
  await page.waitForTimeout((shot.settle ?? 6) * 1000);
  if (shot.frame?.lower) {
    await page.mouse.move(960, 540); await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(960, 540 + shot.frame.lower * i / 20);
    await page.mouse.up();
  }
  for (let i = 0; i < Math.abs(shot.frame?.zoom ?? 0); i++) { await page.mouse.wheel(0, Math.sign(shot.frame!.zoom!) * 120); await page.waitForTimeout(50); }
  await page.waitForTimeout(1500);
  let n = 0, first = 0, last = 0;
  const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const ts = f.metadata.timestamp ?? 0; if (!first) first = ts; last = ts;
    writeFileSync(join(dir, `f${String(n++).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080 });
  await page.waitForTimeout(400);
  await perform(page, shot.move);
  await page.waitForTimeout(400);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  const fps = n > 1 ? (n - 1) / (last - first) : 30;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ frames: n, seconds: last - first, fps }, null, 2));
  console.log(`${shot.name} (${animal ?? 'aerial'}): ${n} frames, ${(last - first).toFixed(1)} s, ${fps.toFixed(1)} fps`);
}
await browser.close();
