import { api, mountAccountBox, wallet } from './account.js';
import type { AccountView } from './accountModel.js';
import { checkTypedData, draftError, draftKey, HABITAT_COLOURS, signError, termsFrom, toMetres, toPixel, typedDataForWallet, usdcAtomic,
  type FormValues } from './challengeNewModel.js';

/** Creating a challenge: the goal, rules and briefing, then the creator signs the USDC authorization (spec §8, §14). */
interface Info {
  chainId: number; contract: string; usdc: string; prizeUsdc: { min: string; max: string }; deadlineDays: number[];
  templates: { survive: { days: number[] }; hunt: { count: number[] } };
  rules: { zone: { radiusM: { min: number; max: number } }; herd: { maxDistanceM: { min: number; max: number } } };
}
type Draft = { draftId: string; description: string; deadline: string; typedData: { domain: Record<string, unknown>; types: Record<string, unknown>;
  primaryType: string; message: Record<string, unknown> } };

const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const say = (text: string) => { $('new-status').textContent = text; };
const options = (sel: HTMLSelectElement, values: Array<[string, string]>) =>
  sel.replaceChildren(...values.map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }));

let info: Info | null = null, account: AccountView | null = null, draft: (Draft & { key: string; value: string | null }) | null = null;
let signing = false;
let patches: Array<{ x: number; y: number; habitat: string }> = [];

function values(): FormValues {
  const n = (id: string) => Number(input(id).value);
  return { template: select('new-template').value as FormValues['template'], speciesId: select('new-species').value,
    days: Number(select('new-days').value), count: Number(select('new-count').value), x: n('new-x'), z: n('new-z'),
    zone: input('new-zone-on').checked ? { x: n('new-zone-x'), z: n('new-zone-z'), radiusM: n('new-zone-radius') } : null,
    noRun: input('new-norun').checked, herd: input('new-herd-on').checked ? n('new-herd-distance') : null,
    briefing: $<HTMLTextAreaElement>('new-briefing').value };
}

function showFields(): void {
  const t = select('new-template').value;
  $('field-days').hidden = t !== 'survive';
  $('field-count').hidden = t !== 'hunt' && t !== 'escape';
  $('field-reach').hidden = t !== 'reach';
  $('field-zone').hidden = !input('new-zone-on').checked;
  $('field-herd').hidden = !input('new-herd-on').checked;
  drawMap();
}

function drawMap(): void {
  const canvas = $<HTMLCanvasElement>('new-map'), ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width, cell = size / 20;
  ctx.fillStyle = '#0b1a24'; ctx.fillRect(0, 0, size, size);
  for (const p of patches) { ctx.fillStyle = HABITAT_COLOURS[p.habitat] ?? '#555'; ctx.fillRect(p.x * cell, p.y * cell, cell + 0.5, cell + 0.5); }
  const f = values();
  if (f.zone) {
    const c = toPixel(f.zone.x, f.zone.z, size);
    ctx.strokeStyle = '#f2d16b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(c.px, c.py, f.zone.radiusM / 6000 * size, 0, Math.PI * 2); ctx.stroke();
  }
  if (f.template === 'reach') {
    const t = toPixel(f.x, f.z, size);
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(t.px, t.py, 5, 0, Math.PI * 2); ctx.fill();
  }
}

function onMapClick(event: MouseEvent): void {
  const canvas = $<HTMLCanvasElement>('new-map'), box = canvas.getBoundingClientRect();
  const at = toMetres((event.clientX - box.left) / box.width * canvas.width, (event.clientY - box.top) / box.height * canvas.height, canvas.width);
  if (select('new-map-sets').value === 'zone') { input('new-zone-on').checked = true; input('new-zone-x').value = String(at.x); input('new-zone-z').value = String(at.z); }
  else { input('new-x').value = String(at.x); input('new-z').value = String(at.z); }
  showFields();
}

async function review(event: Event): Promise<void> {
  event.preventDefault();
  if (signing) return;
  const body = { terms: termsFrom(values()), prizeUsdc: input('new-prize').value, days: Number(select('new-deadline').value) };
  const key = draftKey(body);
  // The same form keeps its draft: reviewing again does not make another one.
  if (draft?.key === key) { $('new-review').hidden = false; return; }
  draft = null; $('new-review').hidden = true;
  say('Checking the challenge…');
  try {
    draft = { ...await api<Draft>('/challenges/drafts', { method: 'POST', body }), key, value: usdcAtomic(body.prizeUsdc) };
    $('new-description').textContent = draft.description;
    $('new-terms').textContent = `Prize ${input('new-prize').value} USDC, taken from ${account?.wallet ?? 'your wallet'}. Deadline ${new Date(draft.deadline).toLocaleString()}. `
      + 'If nobody meets the goal by then, the prize comes back to you an hour later.';
    $('new-review').hidden = false;
    say('Review the challenge, then sign the USDC authorization in your wallet.');
  } catch (e) { say(draftError((e as Error).message)); }
}

async function sign(): Promise<void> {
  // The draft being signed is fixed now, whatever happens to the form meanwhile.
  const d = draft;
  if (!d || !info || signing) return;
  const button = $<HTMLButtonElement>('new-sign'), submit = document.querySelector<HTMLButtonElement>('#new-form button[type="submit"]')!;
  signing = true; button.disabled = true; submit.disabled = true;
  try {
    const eth = wallet();
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const from = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
    const chain = await eth.request({ method: 'eth_chainId' });
    if (typeof chain !== 'string' || Number.parseInt(chain, 16) !== info.chainId) throw new Error('wrong_chain');
    const problem = checkTypedData(d.typedData, from, info, d.value);
    if (problem) throw new Error(problem);
    say('Check your wallet: it asks you to authorize the prize transfer into the challenge contract.');
    const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typedDataForWallet(d.typedData))] });
    await api(`/challenges/drafts/${encodeURIComponent(d.draftId)}/relay`, { method: 'POST', body: { signature } });
    say('Sent to Arc. Your challenge appears on the challenges page in about a minute, once it is confirmed.');
    $('new-review').hidden = true; if (draft === d) draft = null;
  } catch (e) { say(signError(e)); }
  finally { signing = false; button.disabled = false; submit.disabled = false; }
}

async function main(): Promise<void> {
  account = await mountAccountBox((a) => {
    account = a;
    $<HTMLFormElement>('new-form').hidden = !a?.canCreate;
    $('new-cannot').hidden = !!a?.canCreate;
  });
  try {
    info = await api<Info>('/challenges/info');
    const species = (await api<{ species: Array<{ id: string; displayName: string }> }>('/agents/species')).species;
    options(select('new-species'), species.map((s) => [s.id, s.displayName]));
    options(select('new-days'), info.templates.survive.days.map((d) => [String(d), `${d} forest day${d === 1 ? '' : 's'}`]));
    options(select('new-count'), info.templates.hunt.count.map((c) => [String(c), String(c)]));
    options(select('new-deadline'), info.deadlineDays.map((d) => [String(d), `${d} day${d === 1 ? '' : 's'}`]));
    const zone = info.rules.zone.radiusM, herd = info.rules.herd.maxDistanceM;
    Object.assign(input('new-zone-radius'), { min: String(zone.min), max: String(zone.max) });
    Object.assign(input('new-herd-distance'), { min: String(herd.min), max: String(herd.max) });
    Object.assign(input('new-prize'), { min: info.prizeUsdc.min, max: info.prizeUsdc.max, placeholder: `${info.prizeUsdc.min} to ${info.prizeUsdc.max}` });
    patches = (await api<{ patches: Array<{ x: number; y: number; habitat: string }> }>('/patches')).patches;
  } catch { say('Creating challenges is not available on this server right now.'); }
  for (const id of ['new-template', 'new-zone-on', 'new-herd-on', 'new-x', 'new-z', 'new-zone-x', 'new-zone-z', 'new-zone-radius'])
    $(id).addEventListener('input', showFields);
  $('new-map').addEventListener('click', onMapClick);
  $('new-form').addEventListener('submit', (e) => { void review(e); });
  $('new-sign').addEventListener('click', () => { void sign(); });
  showFields();
}

void main();
