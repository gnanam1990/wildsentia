import './pageChrome.js';
import { api, loadAccountState, mountAccountBox } from './account.js';
import { COMMAND_ERRORS, attemptEnded, challengePanel, keyCommand, driveBars, gaitsAllowed, pickTarget, possessMessage, projection, shouldPing, stateMessage,
  type PlayObservation } from './playModel.js';

/** A signed-in person steering an animal, from a phone or a desktop (spec §8, §14). */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const RADIUS_M = 200;
/** How big a tap on prey may be, in CSS pixels, whatever size the map is drawn at. */
const TAP_CSS_PX = 22;
let latest: PlayObservation | null = null, connected = true, signedIn = false, polling = false;
let lastCommand = Date.now(), lastPing = 0, shownState = '';
let outcome: { kind: 'met' | 'failed' | 'void'; text: string } | null = null, queue: string | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

const gait = () => document.querySelector<HTMLInputElement>('input[name="gait"]:checked')?.value ?? 'walk';

/** A command's problem stays on screen for a few seconds, apart from the state line the poll rewrites. */
function feedback(text: string): void {
  $('play-feedback').textContent = text;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { $('play-feedback').textContent = ''; }, 6000);
}

async function command<T = unknown>(path: string, body?: unknown): Promise<T | null> {
  try { const r = await api<T>(`/play/${path}`, { method: 'POST', body }); lastCommand = Date.now(); return r; }
  catch (e) { feedback(COMMAND_ERRORS[(e as Error).message] ?? `That did not work (${(e as Error).message}).`); return null; }
}

function draw(o: PlayObservation): void {
  const canvas = $<HTMLCanvasElement>('play-map'), ctx = canvas.getContext('2d');
  if (!ctx || !o.animal) return;
  const size = canvas.width, p = projection(o.animal.position, RADIUS_M, size);
  ctx.fillStyle = '#13261c'; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  for (let m = 50; m <= RADIUS_M; m += 50) { ctx.beginPath(); ctx.arc(size / 2, size / 2, m * size / (2 * RADIUS_M), 0, Math.PI * 2); ctx.stroke(); }
  for (const w of o.water) { const c = p.toCanvas(w.x, w.z); ctx.fillStyle = '#3d86b8'; ctx.beginPath(); ctx.arc(c.px, c.py, 7, 0, Math.PI * 2); ctx.fill(); }
  for (const n of o.nearby) {
    const c = p.toCanvas(n.x, n.z);
    ctx.fillStyle = n.chasingYou ? '#ff5a3c' : n.huntsYou ? '#e08a4e' : o.huntable.includes(n.speciesId) ? '#f2d16b' : '#9fb3a6';
    ctx.beginPath(); ctx.arc(c.px, c.py, n.predator ? 7 : 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(size / 2, size / 2, 8, 0, Math.PI * 2); ctx.fill();
}

function setState(text: string): void {
  // Written only when it changes, so a screen reader does not repeat it every poll.
  if (text !== shownState) { $('play-state').textContent = text; shownState = text; }
}

function render(o: PlayObservation | null): void {
  setState(stateMessage(o, connected, { idleMinutes: Math.floor((Date.now() - lastCommand) / 60_000), outcome, queue }));
  $('play-pick').hidden = !(signedIn && connected && o && !o.animal && !o.waiting);
  $('play-leave').hidden = !o?.waiting;
  const banner = $('play-outcome');
  banner.hidden = !outcome;
  banner.className = `play-outcome ${outcome?.kind ?? ''}`;
  banner.textContent = outcome?.text ?? '';
  const allowed = gaitsAllowed(o);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="gait"]')) {
    r.disabled = !allowed.includes(r.value);
    if (r.disabled && r.checked) document.querySelector<HTMLInputElement>('input[name="gait"][value="walk"]')!.checked = true;
  }
  if (!o) return;
  if (o.animal) { draw(o); $<HTMLAnchorElement>('play-forest').href = `/#animal=${encodeURIComponent(o.animal.id)}`; }
  $('play-drives').replaceChildren(...(o.animal ? driveBars(o.animal.drives, o.animal.stamina) : []).map((b) => {
    const li = document.createElement('li'), label = document.createElement('span'), bar = document.createElement('span'), fill = document.createElement('i');
    label.textContent = b.label; bar.className = `bar ${b.level}`; fill.style.width = `${Math.round(b.value * 100)}%`; bar.append(fill);
    li.append(label, bar); return li;
  }));
  const card = $('play-challenge');
  card.hidden = !o.challenge;
  if (o.challenge) {
    const panel = challengePanel(o.challenge, Date.now());
    $('play-challenge-title').textContent = `${panel.title} · ${panel.deadline}`;
    $('play-progress').textContent = panel.progress;
    $('play-rules').replaceChildren(...panel.rules.map((r) => { const li = document.createElement('li'); li.textContent = `Rule: ${r}`; return li; }));
    $('play-briefing').hidden = !panel.briefing;
    $('play-briefing-label').textContent = panel.briefing?.label ?? '';
    $('play-briefing-text').textContent = panel.briefing?.text ?? '';
  }
  $('play-notices').replaceChildren(...[...o.notices].reverse().slice(0, 8).map((n) => { const li = document.createElement('li'); li.textContent = n.text; return li; }));
}

async function poll(): Promise<void> {
  if (polling) return; // a slow answer is never overtaken by the next one
  polling = true;
  try {
    const previous = latest;
    try { latest = await api<PlayObservation>('/play/observe'); connected = true; signedIn = true; }
    catch (e) {
      if ((e as Error).message === 'signed_out') { signedIn = false; latest = null; connected = true; render(null); setState('Sign in with X to play.'); return; }
      connected = false;
    }
    if (latest) {
      const ended = attemptEnded(previous, latest);
      if (ended) outcome = ended;
      if (latest.challenge) outcome = null;
      if (latest.animal) queue = null;
    }
    render(latest);
    const now = Date.now();
    if (shouldPing({ visible: document.visibilityState === 'visible', hasAnimal: !!latest?.animal, lastPing, now })) {
      lastPing = now;
      // A presence ping keeps the animal from going idle, so it counts as a command here too.
      void api('/play/presence', { method: 'POST' }).then(() => { lastCommand = Date.now(); }, () => undefined);
    }
  } finally { polling = false; }
}

function onMapTap(event: MouseEvent): void {
  if (!latest?.animal) return;
  const canvas = $<HTMLCanvasElement>('play-map'), box = canvas.getBoundingClientRect();
  const perCss = canvas.width / box.width;
  const p = projection(latest.animal.position, RADIUS_M, canvas.width);
  const target = pickTarget(latest, p, (event.clientX - box.left) * perCss, (event.clientY - box.top) * perCss, TAP_CSS_PX * perCss);
  void (target.kind === 'hunt' ? command('hunt', { animalId: target.id }) : command('move', { to: { x: target.x, z: target.z }, gait: gait() }));
}

async function main(): Promise<void> {
  await mountAccountBox(() => undefined);
  // No accounts on this island: there is nothing to poll, so say so once and stop.
  if (!(await loadAccountState()).enabled) {
    setState(stateMessage(null, true, { off: true }));
    $('play-pick').hidden = true;
    return;
  }
  try {
    const { species } = await api<{ species: Array<{ id: string; displayName: string }> }>('/agents/species');
    $<HTMLSelectElement>('play-species').replaceChildren(...species.map((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.displayName; return o; }));
  } catch { /* the list stays empty; the page still plays an animal already held */ }
  $('play-possess').addEventListener('click', () => {
    void command<{ queued?: number; speciesId?: string }>('possess', { speciesId: $<HTMLSelectElement>('play-species').value })
      .then((r) => { queue = r ? possessMessage(r) : queue; outcome = null; render(latest); });
  });
  $('play-leave').addEventListener('click', () => { void command('challenges/leave').then(() => poll()); });
  $('play-map').addEventListener('click', onMapTap);
  $('play-map').addEventListener('keydown', (event) => {
    if (!latest) return;
    const c = keyCommand(latest, event.key, event);
    // A held arrow still must not scroll the page; it just sends nothing more.
    if (!c) { if (event.repeat && keyCommand(latest, event.key)) event.preventDefault(); return; }
    event.preventDefault();
    void (c.kind === 'hunt' ? command('hunt', { animalId: c.id }) : c.kind === 'stop' ? command('stop')
      : command('move', { to: { x: c.x, z: c.z }, gait: gait() }));
  });
  $('play-stop').addEventListener('click', () => { void command('stop'); });
  for (const action of ['graze', 'drink', 'rest', 'feed']) $(`play-${action}`).addEventListener('click', () => { void command('act', { action }); });
  $('play-climb').addEventListener('click', () => { void command('climb'); });
  $('play-release').addEventListener('click', () => {
    if (confirm('Let your animal go back to the wild? A challenge attempt with it would end.')) void command('release');
  });
  $('play-say').addEventListener('submit', (e) => {
    e.preventDefault();
    const box = $<HTMLInputElement>('play-say-text');
    if (box.value.trim()) void command('say', { text: box.value.trim() }).then((r) => { if (r) box.value = ''; });
  });
  await poll();
  setInterval(() => { void poll(); }, 2000);
}

void main();
