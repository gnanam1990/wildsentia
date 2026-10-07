/**
 * Smooth trailer footage. The page's clock (performance.now and animation-frame time) runs at
 * TIME_SCALE of real time while filming, so the GPU has 1/TIME_SCALE times longer per game frame
 * and never drops one. The camera follows a path computed inside the page on every frame
 * (no stepped mouse input). Each captured frame keeps its timestamp, converted to game time,
 * and the edit (edit.py) places it exactly on a 60 fps timeline.
 *
 * Needs the dev observer (it exposes window.__vana): run
 *   (cd packages/client && npx vite --config vite.e2e.config.ts)
 * against the local stack, then
 *   npx tsx tools/video/film.ts <out-dir> [shot ...]
 */
import { mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { AFTERMATH_S } from '../../packages/client/src/huntActs.js';

const viewer = process.env.VANA_FILM_ORIGIN ?? 'http://localhost:5299';
const api = process.env.VANA_E2E_ORIGIN ?? 'http://localhost:28080';
const TIME_SCALE = Number(process.env.VANA_FILM_TIME_SCALE ?? 0.25);
const out = process.argv[2];
if (!out) throw new Error('usage: film.ts <out-dir> [shot ...]');

/** Camera path, eased from start to end: orbit angle (radians), height angle, distance (m). */
/** distance null: the replay's own "keep both animals framed" owns the zoom, so two writers never fight. */
interface Path { theta: [number, number] | 'behind' | 'side'; phi: [number, number]; distance: [number, number] | null;
  /** Hunts. predator: hold on the hunter. pair: the replay's midpoint, zoomed so both stay in frame. */
  track?: 'predator' | 'pair' }
interface Shot {
  name: string; seconds: number; path: Path;
  species?: string;
  /** A recorded hunt replayed from just before its chase. */
  /** at 'contact': start just before the catch (the kill cut) instead of before the chase. */
  hunt?: { predator?: string; prey?: string[]; lead: number; eventId?: string; at?: 'chase' | 'contact' };
}

const shots: Shot[] = [
  { name: 'a-canopy', species: 'gaur', seconds: 9, path: { theta: [0.4, 1.4], phi: [1.05, 1.25], distance: [70, 190] } },
  { name: 'b-elephant', species: 'elephant', seconds: 7, path: { theta: [2.2, 3.1], phi: [0.22, 0.3], distance: [16, 12] } },
  { name: 'c-chital', species: 'chital', seconds: 6, path: { theta: [0.3, 1.0], phi: [0.18, 0.24], distance: [6.5, 5] } },
  { name: 'd-langur', species: 'langur', seconds: 6, path: { theta: [4.0, 4.7], phi: [0.2, 0.26], distance: [5, 4] } },
  { name: 'e-gaur', species: 'gaur', seconds: 6, path: { theta: [1.2, 1.8], phi: [0.16, 0.2], distance: [8, 7] } },
  // Tigers ambush, so their chases start close. A shot that keeps hunter and quarry both in frame
  // over a 25 m chase leaves them as dots, so each hunt is held on the tiger from the final
  // sprint, through the catch, to the kill.
  { name: 'f-hunt-tiger', seconds: 9, hunt: { predator: 'tiger', lead: 3.5, at: 'contact', eventId: 'hunt_000000010000000000020bc8' },
    path: { theta: [0, 0.5], phi: [0.16, 0.2], distance: [7.5, 5.5], track: 'predator' } },
  // The same kill from the other side, close and low, from just before the spring: the grip and the fall.
  { name: 'g-hunt-sambar', seconds: 6.5, hunt: { predator: 'tiger', lead: 1.2, at: 'contact', eventId: 'hunt_000000010000000000020bc8' },
    path: { theta: [3.5, 3.9], phi: [0.2, 0.24], distance: [5.5, 4.5], track: 'predator' } },
  // A short social clip of one named recorded hunt (VANA_FILM_HUNT_EVENT), in two shots: close on the
  // hunter through the end of its stalk, then wide and side-on with both animals framed (the replay's
  // own pair framing) from the charge through whatever the record says happened next.
  { name: 'glimpse-stalk', seconds: 5.5, hunt: { predator: 'tiger', lead: 6.5, at: 'chase', eventId: process.env.VANA_FILM_HUNT_EVENT },
    path: { theta: 'side', phi: [0.12, 0.14], distance: [6, 5], track: 'predator' } },
  { name: 'glimpse-chase', seconds: 9, hunt: { predator: 'tiger', lead: 0.8, at: 'chase', eventId: process.env.VANA_FILM_HUNT_EVENT },
    path: { theta: 'side', phi: [0.17, 0.2], distance: null } },
  { name: 'h-boar', species: 'boar', seconds: 5, path: { theta: [5.0, 5.6], phi: [0.18, 0.22], distance: [6.5, 5.5] } },
  { name: 'i-squirrel', species: 'squirrel', seconds: 5, path: { theta: [2.0, 2.6], phi: [0.2, 0.24], distance: [3.2, 2.6] } },
  { name: 'j-sambar', species: 'sambar', seconds: 6, path: { theta: [3.0, 3.6], phi: [0.16, 0.2], distance: [7.5, 6.5] } },
  { name: 'k-rise', species: 'elephant', seconds: 10, path: { theta: [0.0, 0.9], phi: [0.3, 1.15], distance: [14, 160] } },
];

interface Patch { id: number; canopyCover: number }
interface Animal { id: string; speciesId: string; patchId: number; state: string; dependent?: boolean }
async function pickAnimal(species: string): Promise<string> {
  const [{ animals }, patchBody] = await Promise.all([
    fetch(`${api}/api/animals`).then((r) => r.json()) as Promise<{ animals: Animal[] }>,
    fetch(`${api}/api/patches`).then((r) => r.json()) as Promise<Patch[] | { patches: Patch[] }>,
  ]);
  const patches = new Map((Array.isArray(patchBody) ? patchBody : patchBody.patches).map((p) => [p.id, p]));
  const score = (a: Animal) => (a.state === 'resting' ? -2 : 0) + (a.dependent ? -1 : 0) - Math.abs((patches.get(a.patchId)?.canopyCover ?? 0) - 0.5) * 3;
  const pool = animals.filter((a) => a.speciesId === species).sort((a, b) => score(b) - score(a));
  if (!pool.length) throw new Error(`no living ${species}`);
  return pool[0]!.id;
}

interface Marker { id: string; type: string; actorId?: string; actors?: string[]; outcome?: string; worldTime: number }
interface Sample { seconds: number; phase: string; predator: { x: number; z: number }; prey: { x: number; z: number } }
/** A successful recorded hunt by the species, newest first, with its chase window. */
async function pickHunt(species: string, used: Set<string>, eventId?: string): Promise<{ predator: string; prey: string; eventId: string; from: number; contact: number; total: number }> {
  const { markers } = await fetch(`${api}/api/event-map`).then((r) => r.json()) as { markers: Marker[] };
  const hunts = markers.filter((m) => m.type === 'hunt' && (eventId ? m.id === eventId : m.outcome === 'success' && !used.has(m.id)) && m.actorId?.startsWith(`${species}_`))
    .sort((a, b) => b.worldTime - a.worldTime);
  // The chase that starts closest makes the best shot: both animals share the frame from the start.
  let best: { predator: string; prey: string; eventId: string; from: number; contact: number; total: number; gap: number } | null = null;
  for (const m of hunts.slice(0, 25)) {
    const body = await fetch(`${api}/api/animals/${m.actorId}/encounters/${m.id}`).then((r) => r.ok ? r.json() : null) as { encounter?: { trace?: { samples: Sample[] } } } | null;
    const samples = body?.encounter?.trace?.samples;
    const chase = samples?.find((s) => s.phase === 'chase');
    if (!samples || !chase) continue;
    const gap = Math.hypot(chase.predator.x - chase.prey.x, chase.predator.z - chase.prey.z);
    const prey = (m.actors ?? []).find((id) => id !== m.actorId) ?? '';
    const contact = (samples.find((s) => s.phase === 'contact') ?? samples.at(-1)!).seconds;
    // The replay of a kill runs on past its last sample (huntReplaySeconds); seek on that span.
    if (!best || gap < best.gap) best = { predator: m.actorId!, prey, eventId: m.id, from: chase.seconds, contact,
      total: samples.at(-1)!.seconds + (m.outcome === 'success' ? AFTERMATH_S : 0), gap };
  }
  if (best) { used.add(best.eventId); console.log(`  ${species} hunt ${best.eventId}: chase starts ${best.gap.toFixed(0)} m apart`); return best; }
  throw new Error(`no recorded ${species} hunt with a chase`);
}

/** Slows the page's clock before any of its code runs. */
function timeScaleScript(scale: number): string {
  return `(() => {
    const realNow = performance.now.bind(performance), t0 = realNow();
    const scaled = (t) => t0 + (t - t0) * ${scale};
    performance.now = () => scaled(realNow());
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => cb(scaled(t)));
  })();`;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__vana && document.querySelector('#view')?.getAttribute('aria-busy') === 'false',
    null, { timeout: 120_000 });
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#render-quality')!;
    select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true }));
    // The observer cutaway fades trunks and branches between camera and animal: right for a
    // viewer, but on film the faded geometry reads as ghostly bands. Film real occlusion instead.
    const cutaway = document.querySelector<HTMLInputElement>('#observer-cutaway')!;
    if (cutaway.checked) { cutaway.checked = false; cutaway.dispatchEvent(new Event('change', { bubbles: true })); }
  });
}

/** Drives the camera along the path on every animation frame, eased, from now for `seconds` of game time. */
/** For 'side': the two animals the camera keeps side-on to (predator, prey). */
async function startPath(page: Page, path: Path, seconds: number, pair: [string, string] | null = null): Promise<void> {
  // A string, so the bundler cannot add helpers (__name) the page does not have.
  await page.evaluate(`(() => {
    const path = ${JSON.stringify(path)}, seconds = ${seconds}, pair = ${JSON.stringify(pair)};
    const v = window.__vana, follow = v.follow, start = performance.now();
    const theta0 = Array.isArray(path.theta) ? path.theta[0] : follow.theta;
    const theta1 = Array.isArray(path.theta) ? path.theta[1] : path.theta === 'behind' ? follow.theta + 0.5 : follow.theta;
    // Side-on to the chase: the camera sits perpendicular to the line from hunter to quarry, and
    // turns toward that only gently, so a swerve never whips the view round.
    let side = null;
    const sideOn = () => {
      const a = v.animals.root.getObjectByName(pair[0]), b = v.animals.root.getObjectByName(pair[1]);
      if (!a || !b) return side ?? follow.theta;
      const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
      if (Math.hypot(dx, dz) < 0.5) return side ?? follow.theta;
      const want = Math.atan2(dx, dz) + Math.PI / 2;
      if (side === null) { side = want; return side; }
      const diff = ((want - side + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      // Of the two side-on views, keep to the one nearer where the camera already is.
      const turn = Math.abs(diff) > Math.PI / 2 ? diff - Math.sign(diff) * Math.PI : diff;
      side += turn * 0.02;
      return side;
    };
    const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / (seconds * 1000)), e = ease(t);
      follow.theta = path.theta === 'side' && pair ? sideOn() : theta0 + (theta1 - theta0) * e;
      follow.phi = path.phi[0] + (path.phi[1] - path.phi[0]) * e;
      follow.zoomBy(1); // drops any eased zoom goal (the replay sets one) so this path owns the distance
      if (path.distance) follow.distance = path.distance[0] + (path.distance[1] - path.distance[0]) * e;
      if (path.track === 'pair' && pair) {
        const a = v.animals.root.getObjectByName(pair[0]), b = v.animals.root.getObjectByName(pair[1]);
        if (a && b) {
          const gap = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
          const want = Math.min(34, Math.max(9, gap * 0.85 + 7));
          follow.distance += (want - follow.distance) * 0.04;
        }
      }
      if (path.track === 'predator' && pair) {
        const hunter = v.animals.root.getObjectByName(pair[0]);
        if (hunter) { follow.target.x = hunter.position.x; follow.target.z = hunter.position.z; }
      }
      follow.rotateBy(0); // holds the viewer's angle: no drift back behind the animal
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`);
}

const wantedShots = new Set(process.argv.slice(3));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await context.addInitScript(timeScaleScript(TIME_SCALE));
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const usedHunts = new Set<string>();
for (const shot of shots) {
  if (wantedShots.size && !wantedShots.has(shot.name)) continue;
  const dir = join(out, shot.name); mkdirSync(dir, { recursive: true });
  // A shot is up to ~3,000 full-HD frames; never fill the disk the rest of the machine needs.
  const free = statfsSync(dir); const freeGb = free.bavail * free.bsize / 1e9;
  if (freeGb < 5) throw new Error(`only ${freeGb.toFixed(1)} GB free; stopping before ${shot.name}`);
  let subject: string, pair: [string, string] | null = null;
  if (shot.hunt) {
    const hunt = await pickHunt(shot.hunt.predator ?? 'tiger', usedHunts, shot.hunt.eventId);
    subject = `${hunt.predator} ${hunt.eventId}`; pair = [hunt.predator, hunt.prey];
    await page.goto(`${viewer}/?cinema=1&maxfps=240#animal=${hunt.predator}`, { waitUntil: 'domcontentloaded' });
    await waitReady(page);
    await page.evaluate(([id, eventId]) => (window as any).__vana.startReplay(id, eventId), [hunt.predator, hunt.eventId]);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#replay-play')!.disabled, null, { timeout: 60_000 });
    await page.waitForTimeout(6000); // the two models load
    const seek = Math.max(0, (shot.hunt.at === 'contact' ? hunt.contact : hunt.from) - shot.hunt.lead) / hunt.total;
    await page.evaluate((s) => {
      const seekBar = document.querySelector<HTMLInputElement>('#replay-seek')!;
      seekBar.value = String(Math.round(s * 1000)); seekBar.dispatchEvent(new Event('input', { bubbles: true }));
    }, seek);
    await page.waitForTimeout(1500);
    if (shot.path.track) await page.evaluate(() => { document.querySelector<HTMLInputElement>('#replay-autoframe')!.checked = false; });
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#replay-play')!.click());
  } else {
    const animal = await pickAnimal(shot.species!);
    subject = animal;
    await page.goto(`${viewer}/?cinema=1&maxfps=240#animal=${animal}`, { waitUntil: 'domcontentloaded' });
    await waitReady(page);
    await page.waitForTimeout(8000); // models and vegetation load (real time)
    // The page clock runs slow while filming, so the follow flight takes longer than it looks:
    // wait until the camera is actually on the animal, or a shot frames empty grass beside it.
    await page.waitForFunction((id) => {
      const v = (window as any).__vana, g = v.animals.root.getObjectByName(id), f = v.follow;
      return g && Math.hypot(f.target.x - g.position.x, f.target.z - g.position.z) < 1
        && v.camera.position.distanceTo(g.position) < 40;
    }, animal, { timeout: 120_000, polling: 250 });
  }
  await startPath(page, shot.path, shot.seconds + 1, pair);
  const stamps: number[] = [];
  let n = 0;
  const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    stamps.push(f.metadata.timestamp ?? 0);
    writeFileSync(join(dir, `f${String(n++).padStart(5, '0')}.jpg`), Buffer.from(f.data, 'base64'));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080 });
  await page.waitForTimeout(((shot.seconds + 0.5) / TIME_SCALE) * 1000);
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', onFrame);
  // Frame times in game seconds from the first frame: what edit.py lays on its 60 fps timeline.
  const game = stamps.map((t) => (t - stamps[0]!) * TIME_SCALE);
  const gaps = game.slice(1).map((t, i) => t - game[i]!);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ subject, frames: n, timeScale: TIME_SCALE, gameSeconds: game.at(-1),
    gameFps: n / (game.at(-1) || 1), worstGapMs: Math.max(...gaps) * 1000, times: game }, null, 1));
  console.log(`${shot.name} (${subject}): ${n} frames over ${game.at(-1)!.toFixed(1)} game s, ${(n / game.at(-1)!).toFixed(0)} fps, worst gap ${(Math.max(...gaps) * 1000).toFixed(1)} ms`);
}
await browser.close();
