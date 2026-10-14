import './pageChrome.js';
import { api } from './account.js';
import { assetState, simAmount, timeLeft, type AssetView } from './congoModel.js';

/** Congo 1E (spec §7): the owner's store, inventory, control panel and bounty board. */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const SPECIES: Record<string, string> = { african_leopard: 'African leopard', blue_duiker: 'Blue duiker', water_chevrotain: 'Water chevrotain',
  bay_duiker: 'Bay duiker', peters_duiker: 'Peters\'s duiker', red_river_hog: 'Red river hog', forest_buffalo: 'Forest buffalo', sitatunga: 'Sitatunga',
  african_golden_cat: 'African golden cat', forest_elephant: 'Forest elephant', agile_mangabey: 'Agile mangabey', crowned_eagle: 'Crowned eagle',
  dwarf_crocodile: 'Dwarf crocodile' };
const name = (id: string) => SPECIES[id] ?? id;
const ERRORS: Record<string, string> = {
  signed_out: 'Sign in first.', no_account: 'Sign in first.', no_wallet: 'Link a wallet to your account first: it is where SIMULATED rewards are recorded.',
  alive_limit: 'You already have the most animals alive at once. Wait for one to die, or sell one.', cooldown: 'Still in its cooldown.',
  already_alive: 'It is already alive.', no_safe_ground: 'There is no safe ground for it right now. Try again shortly.', not_active: 'That animal is locked or retired right now.',
  alive: 'Sell it only while it is not alive.', bad_agent: 'That is not an agent id (it looks like ag_ and 16 letters and digits).', unknown_agent: 'No agent has that id.',
  not_authorised: 'Only its owner or an agent they authorised may steer it.', world_busy: 'The forest is stepping; try again in a moment.',
};
const say = (text: string) => { $('congo-feedback').textContent = text; };
const fail = (e: unknown) => say(ERRORS[(e as Error).message] ?? `That did not work (${(e as Error).message}).`);

interface Store { token: string; decimals: number; maxAlivePerOwner: number; quotes: Array<{ speciesId: string; priceAtomic: string; feeAtomic: string; decimals: number; token: string }> }
let store: Store | null = null;

function button(label: string, onClick: () => Promise<unknown>, quiet = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; if (quiet) b.className = 'quiet';
  b.addEventListener('click', async () => { b.disabled = true; try { await onClick(); await refresh(); } catch (e) { fail(e); } finally { b.disabled = false; } });
  return b;
}

/** Someone is typing or acting in the list: it is not redrawn under them (the next refresh catches up). */
const busyInList = () => $('congo-assets').contains(document.activeElement) && document.activeElement !== document.body
  || [...$('congo-assets').querySelectorAll('input')].some((i) => (i as HTMLInputElement).value !== '');

function renderAssets(assets: Array<AssetView & { agents: string[] }>): void {
  const list = $('congo-assets');
  if (busyInList()) return;
  list.replaceChildren();
  if (assets.length === 0) { const li = document.createElement('li'); li.className = 'small'; li.textContent = 'No animals yet: buy one below.'; list.append(li); }
  for (const a of assets) {
    const li = document.createElement('li'), state = assetState(a, Date.now());
    li.className = `congo-asset tone-${state.tone}`;
    const head = document.createElement('div'); head.className = 'congo-asset-head';
    const title = document.createElement('h3'); title.textContent = `${name(a.speciesId)}${a.life?.animalId ? ` · ${a.life.animalId}` : ''}`;
    const badge = document.createElement('span'); badge.className = 'congo-state'; badge.textContent = state.label;
    head.append(title, badge);
    li.append(head);
    if (state.detail) { const p = document.createElement('p'); p.className = 'small'; p.textContent = state.detail; li.append(p); }
    const controller = a.life?.controller;
    const p = document.createElement('p'); p.className = 'small';
    p.textContent = controller ? `Steered by ${controller.kind === 'owner' ? 'you' : `agent ${controller.id}`}.` : a.life?.status === 'alive' ? 'Living wild: nobody is steering it.' : '';
    li.append(p);
    const actions = document.createElement('div'); actions.className = 'actions';
    if (a.life?.status === 'alive' && a.life.animalId) {
      const animalId = a.life.animalId;
      actions.append(button('Steer it yourself', async () => { await api('/play/possess', { method: 'POST', body: { animalId } }); location.href = '/play.html'; }));
    } else if (state.label !== 'Cooldown') {
      actions.append(button(a.life ? 'Respawn' : 'Spawn into the forest', () => api(`/congo/assets/${a.assetId}/spawn`, { method: 'POST' })));
    }
    if (a.life?.status !== 'alive') actions.append(button('Sell (SIMULATED)', () => api(`/congo/assets/${a.assetId}/sell`, { method: 'POST', body: { idempotencyKey: crypto.randomUUID() } }), true));
    li.append(actions);
    // The control panel: which agents may steer it.
    const agents = document.createElement('div'); agents.className = 'congo-agents';
    const label = document.createElement('p'); label.className = 'small'; label.textContent = a.agents.length ? 'Agents you authorised:' : 'No agent authorised.';
    agents.append(label);
    for (const id of a.agents) {
      const row = document.createElement('div'); row.className = 'congo-inline';
      const code = document.createElement('code'); code.textContent = id;
      row.append(code, button('Revoke', () => api(`/congo/assets/${a.assetId}/agents`, { method: 'POST', body: { agentId: id, grant: false } }), true));
      agents.append(row);
    }
    const form = document.createElement('form'); form.className = 'congo-inline';
    const input = document.createElement('input'); input.placeholder = 'agent id (ag_…)'; input.required = true; input.autocomplete = 'off';
    input.setAttribute('aria-label', `Authorise an agent to steer your ${name(a.speciesId)}`);
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Authorise agent';
    form.append(input, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true;
      try { await api(`/congo/assets/${a.assetId}/agents`, { method: 'POST', body: { agentId: input.value.trim(), grant: true } }); input.value = ''; await refresh(); }
      catch (e) { fail(e); } finally { submit.disabled = false; }
    });
    agents.append(form);
    li.append(agents);
    list.append(li);
  }
}

function renderStore(): void {
  const list = $('congo-store');
  list.replaceChildren();
  for (const q of store?.quotes ?? []) {
    const li = document.createElement('li'); li.className = 'congo-quote';
    const text = document.createElement('span'); text.textContent = `${name(q.speciesId)} — ${simAmount(q.priceAtomic, q.decimals, q.token)}`;
    li.append(text, button('Buy (SIMULATED)', () => api('/congo/store/buy', { method: 'POST', body: { speciesId: q.speciesId, idempotencyKey: crypto.randomUUID() } })));
    list.append(li);
  }
}

async function refreshBoard(): Promise<void> {
  const board = await api<{ bounties: Array<{ speciesId: string; region: string; amountAtomic: string; decimals: number; timeLeftWorldSeconds: number }> }>('/congo/bounties');
  const rows = $('congo-board');
  rows.replaceChildren();
  if (board.bounties.length === 0) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.textContent = 'No open bounties.'; tr.append(td); rows.append(tr); }
  for (const b of board.bounties) {
    const tr = document.createElement('tr');
    for (const text of [name(b.speciesId), b.region, simAmount(b.amountAtomic, b.decimals, store?.token ?? 'SIM-USDC'), timeLeft(b.timeLeftWorldSeconds)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    rows.append(tr);
  }
}

async function refresh(): Promise<void> {
  try {
    const mine = await api<{ assets: Array<AssetView & { agents: string[] }>; maxAlivePerOwner: number }>('/congo/assets');
    const who = 'Signed in. Your animals are below.';
    if ($('congo-who').textContent !== who) $('congo-who').textContent = who;
    $('congo-signin').hidden = true;
    $('congo-limit').textContent = `Up to ${mine.maxAlivePerOwner ?? store?.maxAlivePerOwner ?? 2} of your animals may be alive at once.`;
    renderAssets(mine.assets);
  } catch (e) {
    if ((e as Error).message !== 'signed_out') { fail(e); return; }
    $('congo-who').textContent = 'Sign in to own and steer animals.';
    $('congo-signin').hidden = false;
    renderAssets([]);
  }
  await refreshBoard().catch(() => undefined);
}

/** The local demo server's test people (only it serves this list). */
async function devPeople(): Promise<void> {
  try {
    const people = await api<{ people: Array<{ n: number; name: string }> }>('/dev/people');
    const list = $('congo-dev-people');
    for (const p of people.people) {
      const li = document.createElement('li'), a = document.createElement('a');
      a.href = `/api/dev/signin?person=${p.n}`; a.textContent = `Sign in as ${p.name} (local demo)`;
      li.append(a); list.append(li);
    }
    list.hidden = people.people.length === 0;
  } catch { /* not the demo server */ }
}

$('congo-status-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const out = $('congo-bounty-status'), id = $<HTMLInputElement>('congo-bounty-id').value.trim();
  try {
    const b = await api<{ speciesId: string; region: string; amountAtomic: string; decimals: number; status: string; timeLeftWorldSeconds: number; outcome?: string }>(`/congo/bounties/${encodeURIComponent(id)}`);
    out.textContent = [`${name(b.speciesId)} in ${b.region}`, `Reward ${simAmount(b.amountAtomic, b.decimals, store?.token ?? 'SIM-USDC')}`, `Status: ${b.status}`,
      b.status === 'active' ? `Time left: ${timeLeft(b.timeLeftWorldSeconds)}` : '', b.outcome ? `Outcome: ${b.outcome}` : ''].filter(Boolean).join('\n');
    // A settled bounty can be watched again in the forest, from its record.
    $('congo-bounty-replay').hidden = b.status !== 'settled';
    $<HTMLAnchorElement>('congo-bounty-replay').href = `/#bounty=${encodeURIComponent(id)}`;
  }
  catch (e) {
    out.textContent = (e as Error).message === 'not_found' ? 'No published bounty has that id.' : `Unavailable (${(e as Error).message}).`;
    $('congo-bounty-replay').hidden = true;
  }
  out.hidden = false;
});

void (async () => {
  store = await api<Store>('/congo/store').catch(() => null);
  renderStore();
  await devPeople();
  await refresh();
  setInterval(() => { void refresh(); }, 10_000);
})();
