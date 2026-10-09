import { api, mountAccountBox } from './account.js';
import { challengeOutcome, challengePanel, driveBars, pickTarget, projection, shouldPing, stateMessage, type PlayObservation } from './playModel.js';

/** A signed-in person steering an animal, from a phone or a desktop (spec §8, §14). */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const RADIUS_M = 200;
let latest: PlayObservation | null = null, connected = true, lastCommand = Date.now(), lastPing = 0, signedIn = false;

const gait = () => document.querySelector<HTMLInputElement>('input[name="gait"]:checked')?.value ?? 'walk';
const commandErrors: Record<string, string> = { not_possessing: 'You have no animal.', not_a_hunter: 'Your animal does not hunt.',
  not_prey: 'That is not prey your animal hunts.', no_tree: 'There is no tree to climb here.', not_on_land: 'You cannot go there: it is not land.',
  no_land_route: 'There is no way over land to there.', cooldown: 'Wait a little before taking another animal.', rate_limited: 'Slow down a moment.',
  signed_out: 'Sign in with X to play.', too_soon: 'Wait a few seconds before speaking again.' };

async function command(path: string, body?: unknown): Promise<void> {
  try { await api(`/play/${path}`, { method: 'POST', body }); lastCommand = Date.now(); }
  catch (e) { $('play-state').textContent = commandErrors[(e as Error).message] ?? `That did not work (${(e as Error).message}).`; }
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

function render(o: PlayObservation | null): void {
  const idleMinutes = Math.floor((Date.now() - lastCommand) / 60_000);
  $('play-state').textContent = stateMessage(o, connected, { idleMinutes });
  $('play-pick').hidden = !(signedIn && connected && o && !o.animal && !o.waiting);
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
  const outcome = challengeOutcome(o.notices);
  $('play-notices').replaceChildren(...[...o.notices].reverse().slice(0, 8).map((n) => {
    const li = document.createElement('li'); li.textContent = n.text;
    if (outcome && n.text === outcome.text) li.className = `outcome ${outcome.kind}`;
    return li;
  }));
}

async function poll(): Promise<void> {
  try { latest = await api<PlayObservation>('/play/observe'); connected = true; signedIn = true; }
  catch (e) {
    if ((e as Error).message === 'signed_out') { signedIn = false; latest = null; connected = true; $('play-state').textContent = 'Sign in with X to play.'; return; }
    connected = false;
  }
  render(latest);
  const now = Date.now();
  if (shouldPing({ visible: document.visibilityState === 'visible', hasAnimal: !!latest?.animal, lastPing, now })) {
    lastPing = now;
    void api('/play/presence', { method: 'POST' }).catch(() => undefined);
  }
}

function onMapTap(event: MouseEvent): void {
  if (!latest?.animal) return;
  const canvas = $<HTMLCanvasElement>('play-map'), box = canvas.getBoundingClientRect();
  const p = projection(latest.animal.position, RADIUS_M, canvas.width);
  const target = pickTarget(latest, p, (event.clientX - box.left) / box.width * canvas.width, (event.clientY - box.top) / box.height * canvas.height);
  void (target.kind === 'hunt' ? command('hunt', { animalId: target.id }) : command('move', { to: { x: target.x, z: target.z }, gait: gait() }));
}

async function main(): Promise<void> {
  await mountAccountBox(() => undefined);
  try {
    const { species } = await api<{ species: Array<{ id: string; displayName: string }> }>('/agents/species');
    $<HTMLSelectElement>('play-species').replaceChildren(...species.map((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.displayName; return o; }));
  } catch { /* the list stays empty; the page still plays an animal already held */ }
  $('play-possess').addEventListener('click', () => { void command('possess', { speciesId: $<HTMLSelectElement>('play-species').value }); });
  $('play-map').addEventListener('click', onMapTap);
  $('play-stop').addEventListener('click', () => { void command('stop'); });
  for (const action of ['graze', 'drink', 'rest', 'feed']) $(`play-${action}`).addEventListener('click', () => { void command('act', { action }); });
  $('play-climb').addEventListener('click', () => { void command('climb'); });
  $('play-release').addEventListener('click', () => {
    if (confirm('Let your animal go back to the wild? A challenge attempt with it would end.')) void command('release');
  });
  $('play-say').addEventListener('submit', (e) => {
    e.preventDefault();
    const box = $<HTMLInputElement>('play-say-text');
    if (box.value.trim()) void command('say', { text: box.value.trim() }).then(() => { box.value = ''; });
  });
  await poll();
  setInterval(() => { void poll(); }, 2000);
}

void main();
