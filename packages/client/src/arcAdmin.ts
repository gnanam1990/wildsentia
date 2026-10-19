import './pageChrome.js';
import { timeLeft } from './congoModel.js';
import { WINDOWS, atomicOf, outcomeText, realTime, refusal, short, usdc } from './arcAdminModel.js';

/** The operator's panel for Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md). */
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
let token = '';
try { token = sessionStorage.getItem('arc.adminToken') ?? ''; } catch { /* storage blocked: ask again */ }

interface AdminBounty {
  bountyId: string; status: string; speciesId: string; region: string; amountAtomic: string; timeLeftWorldSeconds: number;
  outcome?: string | null; targetAnimalId: string; payeeWallet: string | null; winnerAnimalId: string | null;
  publishTx: string | null; publishTxUrl: string | null; decideTx?: string | null; decideTxUrl?: string | null; error: string | null;
}
interface AdminView {
  network: number; contract: string; evaluator: string; poolAtomic: string | null; limits: { minAtomic: string; maxAtomic: string } | null;
  bounties: AdminBounty[];
}
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

function render(view: AdminView): void {
  $('arc-network').textContent = view.network === 5042002 ? 'Arc Testnet: testnet USDC only.' : `Chain ${view.network}.`;
  $('arc-pool').textContent = usdc(view.poolAtomic);
  $('arc-limits').textContent = view.limits ? `${usdc(view.limits.minAtomic)} to ${usdc(view.limits.maxAtomic)}` : '—';
  $('arc-contract').replaceChildren(link(`${EXPLORER}/address/${view.contract}`, short(view.contract)));
  const rows = $('arc-bounties');
  rows.replaceChildren();
  if (view.bounties.length === 0) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 6; td.textContent = 'No bounties yet.'; tr.append(td); rows.append(tr);
  }
  for (const b of view.bounties) {
    const tr = document.createElement('tr');
    const cell = (...content: Array<string | HTMLElement>) => { const td = document.createElement('td'); td.append(...content); tr.append(td); return td; };
    cell(`${b.targetAnimalId} (${b.region})`);
    cell(usdc(b.amountAtomic));
    const status = cell(outcomeText(b));
    if (b.error && b.status !== 'paid' && b.status !== 'voided') { const e = document.createElement('div'); e.className = 'small'; e.textContent = b.error; status.append(e); }
    cell(b.status === 'active' ? timeLeft(b.timeLeftWorldSeconds) : '—');
    cell(b.payeeWallet ? link(`${EXPLORER}/address/${b.payeeWallet}`, short(b.payeeWallet)) : '—');
    const txs = cell(link(b.publishTxUrl, b.publishTx ? `reserve ${short(b.publishTx)}` : '—'));
    if (b.decideTx) { txs.append(document.createElement('br'), link(b.decideTxUrl, `${b.outcome === 'void' ? 'return' : 'pay'} ${short(b.decideTx)}`)); }
    rows.append(tr);
  }
}

async function refresh(): Promise<void> {
  if (!token) { $('arc-status').textContent = 'Enter the admin token (the server\'s VANA_ARC_BOUNTIES_ADMIN_TOKEN).'; return; }
  try {
    const [view, candidates] = await Promise.all([admin<AdminView>('/congo/admin/arc-bounties'),
      admin<{ candidates: unknown[]; withHunter: number }>('/congo/admin/arc-bounties/candidates')]);
    render(view);
    $('arc-candidates').textContent = `${candidates.withHunter} with a hunter near (${candidates.candidates.length} in all)`;
    $('arc-status').textContent = 'Token accepted.';
  } catch (e) {
    const code = (e as Error).message;
    $('arc-status').textContent = code === 'admin_only' ? refusal(code) : code === 'http_404' ? 'Arc bounties are not on in this server.' : `Unavailable (${code}).`;
  }
}

const windows = $<HTMLSelectElement>('arc-window');
for (const w of WINDOWS) {
  const o = document.createElement('option'); o.value = String(w.worldSeconds); o.textContent = `${w.label} (${realTime(w.worldSeconds)})`;
  if (w.worldSeconds === 3 * 86_400) o.selected = true;
  windows.append(o);
}

$('arc-token-form').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $<HTMLInputElement>('arc-token').value.trim();
  try { sessionStorage.setItem('arc.adminToken', token); } catch { /* kept in memory only */ }
  void refresh();
});

$('arc-new').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = atomicOf($<HTMLInputElement>('arc-amount').value), button = $<HTMLButtonElement>('arc-publish'), result = $('arc-result');
  if (amount === null) { result.textContent = refusal('bad_amount'); return; }
  button.disabled = true; result.textContent = 'Picking a prey and reserving the bounty on Arc…';
  try {
    const b = await admin<AdminBounty>('/congo/admin/arc-bounties/random', { amountUsdc: Number(amount) / 1e6,
      windowWorldSeconds: Number(windows.value), requireHunter: $<HTMLInputElement>('arc-hunter').checked });
    result.replaceChildren(`Bounty of ${usdc(b.amountAtomic)} on ${b.targetAnimalId} (${b.region}): ${outcomeText(b)}. `,
      link(b.publishTxUrl, b.publishTx ? `Reserve transaction ${short(b.publishTx)}` : ''));
  } catch (e) { result.textContent = refusal((e as Error).message); }
  finally { button.disabled = false; await refresh(); }
});

void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
