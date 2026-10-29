import './pageChrome.js';
import { CONGO_GRID } from '@vana/shared';
import { timeLeft } from './congoModel.js';
import { speciesName } from './animalBrowserModel.js';
import { nearestAnimal, speciesColour, unpackAnimalMap, viewArea, zoomAt, type AnimalMapPayload, type MapAnimal, type MapView } from './animalMapModel.js';
import { WINDOWS, atomicOf, outcomeText, realTime, refusal, short, usdc, whoCanWin } from './arcAdminModel.js';

/**
 * The operator's panel for Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md):
 * choose any prey animal (one agents steer, one found by its number, or one clicked on the map) and
 * drop a bounty on it, or put one on a random prey agents steer.
 */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
// The admin token lives in this page's memory only: a reload asks for it again, and no stored copy outlives the tab.
let token = '';
try { sessionStorage.removeItem('arc.adminToken'); } catch { /* storage blocked: nothing was kept */ }

interface AdminBounty {
  bountyId: string; status: string; speciesId: string; region: string; amountAtomic: string; timeLeftWorldSeconds: number;
  outcome?: string | null; targetAnimalId: string; targetAgentId: string | null; payeeWallet: string | null; winnerAnimalId: string | null;
  publishTx: string | null; publishTxUrl: string | null; decideTx?: string | null; decideTxUrl?: string | null; error: string | null; selection?: string;
}
interface AdminView {
  network: number; contract: string; poolAtomic: string | null; limits: { minAtomic: string; maxAtomic: string } | null; bounties: AdminBounty[];
}
interface Steered { animalId: string; speciesId: string; agentId: string; agentName: string | null; wallet: string | null; droppable: boolean; reason: string | null }
type Check = { ok: true; speciesId: string; eligible: string[]; agentId: string | null; wallet: string | null } | { ok: false; reason: string };
const EXPLORER = 'https://testnet.arcscan.app';

async function admin<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
  return json as T;
}
const link = (href: string | null | undefined, text: string): HTMLElement => {
  if (!href) { const s = document.createElement('span'); s.textContent = text; return s; }
  const a = document.createElement('a'); a.href = href; a.textContent = text; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
};
const button = (text: string, onClick: () => void, quiet = false): HTMLButtonElement => {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (quiet) b.className = 'quiet'; b.addEventListener('click', onClick); return b;
};

// ---------------------------------------------------------------- the chosen animal

let chosen: { animalId: string; check: Check | null } | null = null;
async function choose(animalId: string): Promise<void> {
  chosen = { animalId, check: null };
  renderChosen();
  drawMap();
  try { chosen = { animalId, check: await admin<Check>(`/congo/admin/arc-bounties/animal/${encodeURIComponent(animalId)}`) }; }
  catch (e) { chosen = { animalId, check: { ok: false, reason: (e as Error).message } }; }
  renderChosen();
  $('arc-new').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}
function renderChosen(): void {
  const box = $('arc-chosen'), drop = $<HTMLButtonElement>('arc-drop');
  if (!chosen) { box.textContent = 'No animal chosen yet: pick one above.'; drop.disabled = true; return; }
  const name = document.createElement('strong'); name.textContent = chosen.animalId;
  const detail = document.createElement('div'); detail.className = 'small';
  if (!chosen.check) detail.textContent = 'Checking…';
  else if (chosen.check.ok) {
    const agentName = steered.find((s) => s.animalId === chosen!.animalId)?.agentName ?? null;
    detail.textContent = `${speciesName(chosen.check.speciesId)}. ${whoCanWin({ ...chosen.check, agentName })} Hunted by ${chosen.check.eligible.map(speciesName).join(', ')}.`;
  }
  else detail.textContent = refusal(chosen.check.reason);
  box.replaceChildren(name, detail);
  drop.disabled = !chosen.check?.ok;
}

// ---------------------------------------------------------------- the animals agents steer

let steered: Steered[] = [];
function renderSteered(): void {
  const list = $('arc-steered');
  if (steered.length === 0) { const li = document.createElement('li'); li.className = 'small'; li.textContent = 'No agent steers an animal right now.'; list.replaceChildren(li); return; }
  list.replaceChildren(...steered.map((s) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${s.animalId} · ${s.agentName ?? s.agentId}${s.wallet ? '' : ' · no proven wallet'}${s.droppable ? '' : ` · ${refusal(s.reason ?? '')}`}`;
    const b = button('Choose', () => { void choose(s.animalId); }, !s.droppable);
    b.disabled = !s.droppable;
    li.append(text, b);
    return li;
  }));
}

// ---------------------------------------------------------------- search

async function search(): Promise<void> {
  const q = $<HTMLInputElement>('arc-search-q').value.trim().toLowerCase(), species = $<HTMLSelectElement>('arc-search-species').value;
  const results = $('arc-search-results');
  const params = new URLSearchParams({ limit: '20' });
  if (q) params.set('q', q);
  if (species) params.set('species', species);
  try {
    const page = await (await fetch(`/api/animals/list?${params}`, { cache: 'no-store' })).json() as { total: number; animals: Array<{ id: string; speciesId: string; state: string; stage: string }> };
    if (page.animals.length === 0) { const li = document.createElement('li'); li.className = 'small'; li.textContent = 'No living animal matches.'; results.replaceChildren(li); return; }
    results.replaceChildren(...page.animals.map((a) => {
      const li = document.createElement('li'), text = document.createElement('span');
      text.textContent = `${a.id} · ${a.stage}, ${a.state.replaceAll('_', ' ')}`;
      li.append(text, button('Choose', () => { void choose(a.id); }));
      return li;
    }), ...(page.total > page.animals.length ? [Object.assign(document.createElement('li'), { className: 'small', textContent: `${page.total - page.animals.length} more: narrow the search.` })] : []));
  } catch { results.replaceChildren(Object.assign(document.createElement('li'), { className: 'small', textContent: 'The search is unavailable.' })); }
}

// ---------------------------------------------------------------- the map

const canvas = $<HTMLCanvasElement>('arc-map');
const SPAN = CONGO_GRID.cols * CONGO_GRID.patchM, ORIGIN = -CONGO_GRID.patchM / 2;
let animals: MapAnimal[] = [];
let view: MapView = { cx: ORIGIN + SPAN / 2, cz: ORIGIN + SPAN / 2, scale: 0.01 };
let fitted = false;
const allSpecies = () => new Set(animals.map((a) => a.speciesId));
function fit(): void { const r = canvas.getBoundingClientRect(); if (r.width > 0) { view = { cx: ORIGIN + SPAN / 2, cz: ORIGIN + SPAN / 2, scale: Math.min(r.width, r.height) / SPAN }; fitted = true; } }
const minScale = () => { const r = canvas.getBoundingClientRect(); return Math.min(r.width || 400, r.height || 400) / SPAN * 0.8; };
function drawMap(): void {
  const r = canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
  if (r.width === 0) return;
  if (!fitted) fit();
  canvas.width = Math.round(r.width * ratio); canvas.height = Math.round(r.height * ratio);
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.fillStyle = '#1f3a28'; c.fillRect(0, 0, r.width, r.height);
  const sx = (x: number) => (x - view.cx) * view.scale + r.width / 2, sz = (z: number) => (z - view.cz) * view.scale + r.height / 2;
  const size = Math.min(7, Math.max(2, 2 + Math.log2(view.scale / 0.01)));
  const steeredIds = new Set(steered.map((s) => s.animalId));
  for (const a of animals) {
    const x = sx(a.x), z = sz(a.z);
    if (x < -8 || z < -8 || x > r.width + 8 || z > r.height + 8) continue;
    c.fillStyle = speciesColour(a.speciesId);
    const s = steeredIds.has(a.id) ? size * 2.2 : size;
    c.fillRect(x - s / 2, z - s / 2, s, s);
  }
  const mark = (id: string, colour: string) => {
    const a = animals.find((m) => m.id === id);
    if (!a) return;
    c.strokeStyle = colour; c.lineWidth = 2; c.beginPath(); c.arc(sx(a.x), sz(a.z), 9, 0, Math.PI * 2); c.stroke();
  };
  for (const id of steeredIds) mark(id, '#ffffff');
  if (chosen) mark(chosen.animalId, '#ffd84a');
}
async function loadMap(): Promise<void> {
  try {
    animals = unpackAnimalMap(await (await fetch('/api/animals/map', { cache: 'no-store' })).json() as AnimalMapPayload);
    const select = $<HTMLSelectElement>('arc-search-species');
    if (select.options.length === 1) {
      for (const id of [...allSpecies()].sort()) { const o = document.createElement('option'); o.value = id; o.textContent = speciesName(id); select.append(o); }
    }
    $('arc-map-note').textContent = `${animals.length.toLocaleString('en-US')} living animals. Larger dots, ringed in white, are animals agents steer; the chosen one is ringed in yellow.`;
    drawMap();
  } catch { $('arc-map-note').textContent = 'The map is unavailable.'; }
}
const zoom = (factor: number) => { const r = canvas.getBoundingClientRect(); view = zoomAt(view, factor, r.width / 2, r.height / 2, r.width, r.height, minScale(), 2); drawMap(); };
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, r.width, r.height, minScale(), 2);
  drawMap();
}, { passive: false });
let drag: { x: number; z: number; moved: boolean; view: MapView } | null = null;
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, z: e.clientY, moved: false, view: { ...view } }; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dz = e.clientY - drag.z;
  if (Math.hypot(dx, dz) > 4) drag.moved = true;
  if (drag.moved) { view = { ...drag.view, cx: drag.view.cx - dx / view.scale, cz: drag.view.cz - dz / view.scale }; drawMap(); }
});
canvas.addEventListener('pointerup', (e) => {
  const d = drag; drag = null;
  if (!d || d.moved) return;
  const r = canvas.getBoundingClientRect();
  const area = viewArea(view, r.width, r.height);
  const x = area.minX + (e.clientX - r.left) / view.scale, z = area.minZ + (e.clientY - r.top) / view.scale;
  const hit = nearestAnimal(animals, x, z, 10 / view.scale, allSpecies());
  if (hit) void choose(hit.id);
});
$('arc-zoom-in').addEventListener('click', () => zoom(2));
$('arc-zoom-out').addEventListener('click', () => zoom(0.5));
$('arc-zoom-all').addEventListener('click', () => { fit(); drawMap(); });
new ResizeObserver(() => drawMap()).observe(canvas);

// ---------------------------------------------------------------- pool and bounties

function renderView(v: AdminView): void {
  $('arc-network').textContent = v.network === 5042002 ? 'Arc Testnet: testnet USDC only.' : `Chain ${v.network}.`;
  $('arc-pool').textContent = usdc(v.poolAtomic);
  $('arc-limits').textContent = v.limits ? `${usdc(v.limits.minAtomic)} to ${usdc(v.limits.maxAtomic)}` : '—';
  $('arc-contract').replaceChildren(link(`${EXPLORER}/address/${v.contract}`, short(v.contract)));
  const rows = $('arc-bounties');
  rows.replaceChildren();
  if (v.bounties.length === 0) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = 'No bounties yet.'; tr.append(td); rows.append(tr); }
  for (const b of v.bounties) {
    const tr = document.createElement('tr');
    const cell = (...content: Array<string | HTMLElement>) => { const td = document.createElement('td'); td.append(...content); tr.append(td); return td; };
    cell(`${b.targetAnimalId} (${b.region})${b.targetAgentId ? '' : ', wild'}${b.selection === 'random' ? ', random' : ''}`);
    cell(usdc(b.amountAtomic));
    const status = cell(outcomeText(b));
    if (b.error && b.status !== 'paid' && b.status !== 'voided') { const e = document.createElement('div'); e.className = 'small'; e.textContent = b.error; status.append(e); }
    cell(b.status === 'active' ? timeLeft(b.timeLeftWorldSeconds) : '—');
    cell(b.payeeWallet ? link(`${EXPLORER}/address/${b.payeeWallet}`, short(b.payeeWallet)) : '—');
    const txs = cell(link(b.publishTxUrl, b.publishTx ? `reserve ${short(b.publishTx)}` : '—'));
    if (b.decideTx) txs.append(document.createElement('br'), link(b.decideTxUrl, `${b.outcome === 'void' ? 'return' : 'pay'} ${short(b.decideTx)}`));
    rows.append(tr);
  }
}

async function refresh(): Promise<void> {
  if (!token) { $('arc-status').textContent = 'Enter the admin token (the server\'s VANA_ARC_BOUNTIES_ADMIN_TOKEN).'; return; }
  try {
    const [v, s] = await Promise.all([admin<AdminView>('/congo/admin/arc-bounties'), admin<{ animals: Steered[] }>('/congo/admin/arc-bounties/steered')]);
    steered = s.animals;
    renderView(v); renderSteered(); drawMap();
    $('arc-candidates').textContent = `${steered.filter((x) => x.droppable).length} steered by agents (${steered.length} steered in all); any wild prey too`;
    $('arc-status').textContent = 'Token accepted.';
  } catch (e) {
    const code = (e as Error).message;
    $('arc-status').textContent = code === 'admin_only' ? refusal(code) : code === 'http_404' ? 'Arc bounties are not on in this server.' : `Unavailable (${code}).`;
  }
}

// ---------------------------------------------------------------- forms

const windows = $<HTMLSelectElement>('arc-window');
for (const w of WINDOWS) {
  const o = document.createElement('option'); o.value = String(w.worldSeconds); o.textContent = `${w.label} (${realTime(w.worldSeconds)})`;
  if (w.worldSeconds === 3 * 86_400) o.selected = true;
  windows.append(o);
}
$('arc-token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $<HTMLInputElement>('arc-token').value.trim();
  void refresh();
});
$('arc-search').addEventListener('submit', (event) => { event.preventDefault(); void search(); });

async function publish(path: string, extra: Record<string, unknown>): Promise<void> {
  const amount = atomicOf($<HTMLInputElement>('arc-amount').value), result = $('arc-result');
  if (amount === null) { result.textContent = refusal('bad_amount'); return; }
  const buttons = [$<HTMLButtonElement>('arc-drop'), $<HTMLButtonElement>('arc-random')];
  for (const b of buttons) b.disabled = true;
  result.textContent = 'Reserving the bounty on Arc…';
  try {
    const b = await admin<AdminBounty>(path, { amountUsdc: Number(amount) / 1e6, windowWorldSeconds: Number(windows.value), ...extra });
    result.replaceChildren(`Bounty of ${usdc(b.amountAtomic)} on ${b.targetAnimalId}: ${outcomeText(b)}. `,
      link(b.publishTxUrl, b.publishTx ? `Reserve transaction ${short(b.publishTx)}` : ''));
    chosen = null;
  } catch (e) { result.textContent = refusal((e as Error).message); }
  finally { buttons[1]!.disabled = false; renderChosen(); await refresh(); }
}
$('arc-new').addEventListener('submit', (event) => {
  event.preventDefault();
  if (chosen?.check?.ok) void publish('/congo/admin/arc-bounties/drop', { animalId: chosen.animalId });
});
$('arc-random').addEventListener('click', () => { void publish('/congo/admin/arc-bounties/random', { requireHunter: true }); });

renderChosen();
void loadMap();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
setInterval(() => { if (!document.hidden) void loadMap(); }, 60_000);
