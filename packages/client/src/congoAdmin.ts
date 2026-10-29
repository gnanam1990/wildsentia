import './pageChrome.js';
import { simAmount, timeLeft } from './congoModel.js';

/** Congo 1D/1E (spec §5): the operator's bounty editor: presets, drafts, validation, publication, cancellation. */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
// The admin token lives in this page's memory only: a reload asks for it again, and no stored copy outlives the tab.
let token = '';
try { sessionStorage.removeItem('congo.adminToken'); } catch { /* storage blocked: nothing was kept */ }

interface AdminBounty {
  bountyId: string; status: string; preset: string; speciesId: string; region: string; amountAtomic: string; decimals: number;
  timeLeftWorldSeconds: number; targetAnimalId: string; targetOwnerWallet: string; validation: Record<string, boolean> | null;
  outcome: string | null; winnerWallet: string | null; cancelReason: string | null; holdReason: string | null; rulesHash: string | null;
}

async function admin<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
  return json as T;
}
const say = (text: string) => { $('admin-feedback').textContent = text; };

function action(label: string, run: () => Promise<unknown>, quiet = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; if (quiet) b.className = 'quiet';
  b.addEventListener('click', async () => { b.disabled = true; try { await run(); say(''); await refresh(); } catch (e) { say(`${label}: ${(e as Error).message}`); } finally { b.disabled = false; } });
  return b;
}

function render(bounties: AdminBounty[]): void {
  const list = $('admin-bounties');
  list.replaceChildren();
  for (const b of bounties) {
    const li = document.createElement('li'); li.className = 'congo-asset';
    const head = document.createElement('div'); head.className = 'congo-asset-head';
    const h = document.createElement('h3'); h.textContent = `${b.preset} · ${b.speciesId} in ${b.region} · ${simAmount(b.amountAtomic, b.decimals, 'SIM-USDC')}`;
    const s = document.createElement('span'); s.className = 'congo-state'; s.textContent = b.status;
    head.append(h, s); li.append(head);
    const p = document.createElement('p'); p.className = 'small';
    p.textContent = [`Target ${b.targetAnimalId}`, b.status === 'active' ? `${timeLeft(b.timeLeftWorldSeconds)} left` : '', b.outcome ? `outcome ${b.outcome}` : '',
      b.winnerWallet ? `paid to ${b.winnerWallet}` : '', b.cancelReason ? `cancelled: ${b.cancelReason}` : '', b.holdReason ? `held: ${b.holdReason}` : '',
      `id ${b.bountyId}`].filter(Boolean).join(' · ');
    li.append(p);
    if (b.validation) {
      const ul = document.createElement('ul'); ul.className = 'congo-checks';
      for (const [check, ok] of Object.entries(b.validation)) { const c = document.createElement('li'); c.className = ok ? 'pass' : 'fail'; c.textContent = check; ul.append(c); }
      li.append(ul);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    if (b.status === 'draft' || b.status === 'validated') actions.append(action('Validate', () => admin(`/congo/admin/bounties/${b.bountyId}/validate`, {})));
    if (b.status === 'validated') actions.append(action('Publish (reserves the reward)', () => admin(`/congo/admin/bounties/${b.bountyId}/publish`, {})));
    if (b.status === 'on_hold') actions.append(action('Resume after review', () => admin(`/congo/admin/bounties/${b.bountyId}/resume`, {})));
    if (['draft', 'validated', 'active', 'on_hold'].includes(b.status)) actions.append(action('Cancel…', async () => {
      const reason = prompt('Why cancel? (recorded; the reservation returns to the pool)');
      if (reason?.trim()) await admin(`/congo/admin/bounties/${b.bountyId}/cancel`, { reason });
    }, true));
    li.append(actions);
    list.append(li);
  }
}

async function refresh(): Promise<void> {
  if (!token) { $('admin-status').textContent = 'Enter the admin token to use the editor.'; return; }
  try {
    const presets = await admin<{ presets: Array<{ id: string; label: string; amountAtomic: string; decimals: number; windowWorldSeconds: number }> }>('/congo/admin/bounties/presets');
    const rows = $('admin-presets'), select = $<HTMLSelectElement>('draft-preset');
    rows.replaceChildren(); select.replaceChildren();
    for (const p of presets.presets) {
      const tr = document.createElement('tr');
      for (const text of [p.id, simAmount(p.amountAtomic, p.decimals, 'SIM-USDC'), timeLeft(p.windowWorldSeconds)]) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      rows.append(tr);
      const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; select.append(o);
    }
    render((await admin<{ bounties: AdminBounty[] }>('/congo/admin/bounties')).bounties);
    $('admin-status').textContent = 'Token accepted.';
  } catch (e) { $('admin-status').textContent = (e as Error).message === 'admin_only' ? 'That token was refused.' : `Unavailable (${(e as Error).message}).`; }
}

$('admin-token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $<HTMLInputElement>('admin-token').value.trim();
  void refresh();
});
$('admin-draft').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await admin('/congo/admin/bounties', { targetAnimalId: $<HTMLInputElement>('draft-animal').value.trim(), preset: $<HTMLSelectElement>('draft-preset').value });
    say(''); await refresh();
  } catch (e) { say(`Draft: ${(e as Error).message}`); }
});
void refresh();
