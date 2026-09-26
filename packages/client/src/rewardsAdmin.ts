import { pendingAllocationMatch, shouldLockRewardAdmin } from './rewardPending.js';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
let token = '';
let generation = 0;
let receiptVerificationAvailable = false;
/** The world the server is running; a drop from another world can only be cancelled. */
let currentWorldId: string | null = null;
let dropId: string = crypto.randomUUID();
interface PendingDrop { id: string; actorId: string; amount: string; revealWhen: string }
const pendingKey = 'vana-pending-reward-allocation-v1';
function storedPending(): PendingDrop | null {
  try {
    const raw = sessionStorage.getItem(pendingKey); if (!raw) return null;
    const value = JSON.parse(raw) as PendingDrop;
    return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) && typeof value.actorId === 'string'
      && typeof value.amount === 'string' && ['watch', 'carcass'].includes(value.revealWhen) ? value : null;
  } catch { return null; }
}
let pendingDrop: PendingDrop | null = storedPending();
let pendingConflict = false;
if (pendingDrop) dropId = pendingDrop.id;
function clearPending(): void {
  pendingDrop = null;
  pendingConflict = false;
  try { sessionStorage.removeItem(pendingKey); } catch { /* The server-side idempotency key still prevents duplicate creation. */ }
}
const status = $('#admin-status');
const input = (id: string) => $<HTMLInputElement>(id);
if (pendingDrop) {
  input('#drop-actor').value = pendingDrop.actorId;
  input('#drop-amount').value = pendingDrop.amount;
  $<HTMLSelectElement>('#drop-when').value = pendingDrop.revealWhen;
  status.textContent = 'An earlier allocation result is uncertain. Unlock, inspect the ledger, then retry unchanged inputs if it is absent.';
}
const usd = (raw: string): string => { const n = BigInt(raw); return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`; };
async function api(path: string, body?: unknown): Promise<unknown> {
  const requestToken = token;
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${requestToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json() as { error?: string };
  if (shouldLockRewardAdmin(response.status, requestToken, token)) {
    $<HTMLButtonElement>('#admin-lock').click();
    status.textContent = 'Administrator access was rejected. Private ledger cleared and tab locked.';
  }
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: response.status }); return data;
}
interface Claim { id: string; drop_id: string; wallet: string; status: string; actor_id: string; amount_micro: string; network: string }
interface Drop { id: string; actorId: string; amount: string; network: string; status: string; revealWhen: string; worldId?: string | null }
interface Audit { action: string; drop_id: string; transaction_ref: string | null; created_at: string; note: string }
type LedgerKind = 'claims' | 'drops' | 'audit';
interface Ledger { claims: Claim[]; drops: Drop[]; audit: Audit[]; next: Record<LedgerKind, string | null>; receiptVerificationAvailable: boolean;
  currentWorldId?: string | null; limits?: { minWatchSeconds: number; walletDailyLimit: number | null; clientDailyLimit: number | null } }
const nextPage: Record<LedgerKind, string | null> = { claims: null, drops: null, audit: null };
function paragraph(text: string): HTMLParagraphElement { const p = document.createElement('p'); p.textContent = text; return p; }
function button(text: string, action: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.textContent = text; b.onclick = action; return b;
}
function claimRow(c: Claim): HTMLElement {
  const row = document.createElement('section'); row.className = 'map-event';
  row.append(paragraph(`${c.actor_id} · ${usd(c.amount_micro)} USDC · ${c.network} · ${c.status}`), paragraph(c.wallet), paragraph(`Claim ${c.id}`));
  if (c.status === 'reserved') {
    if (receiptVerificationAvailable) row.append(button('Verify and record existing Base transfer', () => settleVerified(c)));
    row.append(button('Record payment without chain verification', () => review(c.drop_id, c, 'report_paid')),
      button('Reject and reopen', () => review(c.drop_id, c, 'reject')));
  }
  return row;
}
function dropRow(d: Drop): HTMLElement {
  const row = document.createElement('section'); row.className = 'map-event';
  const elsewhere = d.worldId && currentWorldId && d.worldId !== currentWorldId;
  row.append(paragraph(`${d.actorId} · ${d.amount} USDC · ${d.status}${elsewhere ? ' · from an earlier world: not claimable' : ''}`), paragraph(d.id));
  if (d.status === 'open') row.append(button('Cancel allocation', () => review(d.id, null, 'cancel')));
  return row;
}
function rows(kind: LedgerKind, items: Claim[] | Drop[] | Audit[], append: boolean): void {
  const container = $(`#admin-${kind}`);
  const elements = kind === 'claims' ? (items as Claim[]).map(claimRow)
    : kind === 'drops' ? (items as Drop[]).map(dropRow)
      : (items as Audit[]).map((a) => paragraph(`${a.created_at} · ${a.action} · ${a.drop_id}${a.transaction_ref ? ` · ${a.transaction_ref}` : ''}${a.note ? ` · ${a.note}` : ''}`));
  if (append) container.append(...elements); else container.replaceChildren(...elements);
}
function pageButton(kind: LedgerKind): HTMLButtonElement { return $<HTMLButtonElement>(`#admin-more-${kind}`); }
function setNext(kind: LedgerKind, cursor: string | null): void {
  nextPage[kind] = cursor; pageButton(kind).hidden = !cursor;
}
async function loadOlder(kind: LedgerKind): Promise<void> {
  const cursor = nextPage[kind]; if (!cursor || !token) return;
  const current = generation, button = pageButton(kind); button.disabled = true;
  try {
    const result = await api(`/admin/rewards/page?kind=${kind}&cursor=${encodeURIComponent(cursor)}`) as { items: Claim[] | Drop[] | Audit[]; next: string | null };
    if (current !== generation || !token) return;
    rows(kind, result.items, true); setNext(kind, result.next);
    const pendingMatch = kind === 'drops' ? pendingAllocationMatch(pendingDrop, result.items as Drop[]) : 'absent';
    if (pendingMatch === 'conflict') pendingConflict = true;
    const resolvedPending = pendingMatch === 'exact';
    if (resolvedPending) { clearPending(); dropId = crypto.randomUUID(); $<HTMLFormElement>('#drop-form').reset(); }
    status.textContent = pendingMatch === 'conflict'
      ? 'The earlier allocation ID exists with different terms. Stop; do not retry or create another allocation until investigated.'
      : resolvedPending
      ? 'Earlier allocation found on an older page; its uncertain retry ID is resolved. No payment was sent.'
      : `Older ${kind} loaded. Refresh to see current statuses.`;
  } catch (error) { if (current === generation) status.textContent = `${(error as Error).message}. Older ${kind} were not loaded; retry without sending a payment.`; }
  finally { button.disabled = false; }
}
for (const kind of ['claims', 'drops', 'audit'] as const) pageButton(kind).onclick = () => { void loadOlder(kind); };
function settleVerified(claim: Claim): void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog reward-dialog';
  dialog.setAttribute('aria-labelledby', 'verify-payment-title');
  const title = document.createElement('h2'); title.id = 'verify-payment-title'; title.textContent = 'Verify an existing Base USDC transfer';
  const form = document.createElement('form');
  form.append(paragraph(`${usd(claim.amount_micro)} native USDC on Base → ${claim.wallet}`),
    paragraph('This checks an already-sent, finalized transfer from the configured payout wallet. It does not send USDC. If a transfer outcome is uncertain, investigate the wallet first; never send it again just because this check fails.'));
  const hashLabel = document.createElement('label'); hashLabel.textContent = 'Base transaction hash';
  const hash = document.createElement('input'); hash.required = true; hash.pattern = '0x[0-9a-fA-F]{64}'; hash.maxLength = 66;
  hashLabel.append(hash);
  const indexLabel = document.createElement('label'); indexLabel.textContent = 'Transfer log index in the receipt';
  const logIndex = document.createElement('input'); logIndex.type = 'number'; logIndex.required = true;
  logIndex.min = '0'; logIndex.max = '1000000'; logIndex.step = '1'; indexLabel.append(logIndex);
  const checkLabel = document.createElement('label'); const check = document.createElement('input');
  check.type = 'checkbox'; check.required = true;
  checkLabel.append(check, document.createTextNode(' I have already sent the intended transfer and independently checked its transaction hash.'));
  const message = paragraph(''); message.setAttribute('role', 'status');
  const submit = document.createElement('button'); submit.textContent = 'Verify receipt and update ledger'; submit.type = 'submit';
  const cancel = button('Back', () => dialog.close()); cancel.type = 'button';
  form.append(hashLabel, indexLabel, checkLabel, message, submit, cancel);
  form.onsubmit = (event) => {
    event.preventDefault(); if (submit.disabled) return;
    const parsedIndex = Number(logIndex.value);
    if (!Number.isSafeInteger(parsedIndex) || parsedIndex < 0 || parsedIndex > 1_000_000) {
      message.textContent = 'Enter the exact non-negative Transfer log index.'; return;
    }
    submit.disabled = true;
    void api('/admin/rewards/settle-verified', { dropId: claim.drop_id, claimId: claim.id,
      transactionRef: hash.value.trim(), logIndex: parsedIndex })
      .then(() => { dialog.close(); return refresh(); })
      .catch((error: Error) => { message.textContent = `${error.message}. Check the current ledger and chain receipt before retrying these exact details; do not send another transfer.`; submit.disabled = false; });
  };
  dialog.append(title, form); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); hash.focus();
}
function review(drop: string, claim: Claim | null, action: 'reject' | 'cancel' | 'report_paid'): void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog reward-dialog';
  dialog.setAttribute('aria-labelledby', 'review-title');
  const title = document.createElement('h2'); title.id = 'review-title';
  title.textContent = action === 'report_paid' ? 'Record a manual Base payment' : action === 'reject' ? 'Reject reservation and reopen reward' : 'Cancel unclaimed allocation';
  const form = document.createElement('form');
  form.append(paragraph(claim ? `${usd(claim.amount_micro)} USDC on Base → ${claim.wallet}` : `Allocation ${drop}`));
  let reference: HTMLInputElement | null = null;
  const reason = document.createElement('input'); reason.required = true; reason.maxLength = 240; reason.minLength = 5;
  const reasonLabel = document.createElement('label'); reasonLabel.textContent = 'Audit note (no secrets)'; reasonLabel.append(reason); form.append(reasonLabel);
  if (action === 'report_paid') {
    const label = document.createElement('label'); label.textContent = 'Base transaction hash';
    reference = document.createElement('input'); reference.required = true; reference.pattern = '0x[0-9a-fA-F]{64}'; reference.maxLength = 66;
    label.append(reference); form.append(label, paragraph('This records your report only. It does not send money or verify the transaction. Do not resend if an earlier transfer has an uncertain result.'));
  } else if (action === 'reject') form.append(paragraph('Do not reject a reservation after sending a payment or while a transfer is uncertain. Rejecting makes this reward available to another observer.'));
  const checkLabel = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.required = true;
  checkLabel.append(check, document.createTextNode(action === 'report_paid'
    ? ' I independently checked the recipient, amount, token and successful Base transfer.'
    : ' I understand this changes the allocation / reservation and have not sent an uncertain payment.'));
  const message = paragraph(''); message.setAttribute('role', 'status');
  const submit = document.createElement('button'); submit.textContent = 'Confirm ledger update'; submit.type = 'submit';
  const cancel = button('Back', () => dialog.close()); cancel.type = 'button';
  form.append(checkLabel, message, submit, cancel);
  form.onsubmit = (e) => {
    e.preventDefault(); if (submit.disabled) return; submit.disabled = true;
    void api('/admin/rewards/review', { dropId: drop, claimId: claim?.id, action, transactionRef: reference?.value.trim(), note: reason.value.trim() })
      .then(() => { dialog.close(); return refresh(); })
      .catch((error: Error) => { message.textContent = `${error.message}. Refresh the ledger before retrying; never resend a transfer automatically.`; submit.disabled = false; });
  };
  dialog.append(title, form); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); reason.focus();
}
async function refresh(): Promise<void> {
  const current = ++generation; status.textContent = 'Loading private ledger…';
  try {
    const [raw, summaryResponse, animalResponse, carcassResponse] = await Promise.all([
      api('/admin/rewards'), fetch('/api/rewards/summary'), fetch('/api/animals'), fetch('/api/carcasses')]);
    if (current !== generation || !token) return;
    const ledger = raw as Ledger;
    if (!summaryResponse.ok || !animalResponse.ok || !carcassResponse.ok) throw new Error('Supporting data unavailable');
    const summary = await summaryResponse.json() as { available: string; reserved: string; paidReported: string; verifiedPaid?: string };
    const animals = await animalResponse.json() as { animals: Array<{ id: string }> };
    const carcasses = await carcassResponse.json() as { carcasses: Array<{ originId: string }> };
    if (current !== generation || !token) return;
    const pendingMatch = pendingAllocationMatch(pendingDrop, ledger.drops);
    if (pendingMatch === 'conflict') pendingConflict = true;
    const resolvedPending = pendingMatch === 'exact';
    if (resolvedPending) {
      clearPending(); dropId = crypto.randomUUID(); $<HTMLFormElement>('#drop-form').reset();
    }
    receiptVerificationAvailable = ledger.receiptVerificationAvailable === true;
    currentWorldId = ledger.currentWorldId ?? null;
    $('#admin-work').hidden = false; $('#admin-login').hidden = true;
    $('#admin-totals').textContent = `${summary.available} USDC unclaimed allocation · ${summary.reserved} reserved · ${summary.verifiedPaid ?? '0.000000'} receipt-verified paid · ${summary.paidReported} payment reported (unverified). Allocation is not a proven treasury balance.`
      + (ledger.limits ? ` Claims need ${ledger.limits.minWatchSeconds} s of watching; at most ${ledger.limits.walletDailyLimit ?? 'unlimited'} win(s) per wallet and ${ledger.limits.clientDailyLimit ?? 'unlimited'} per network address in 24 h.` : '');
    $('#reward-animals').replaceChildren(...[...animals.animals.map((a) => a.id), ...carcasses.carcasses.map((c) => c.originId)]
      .map((id) => new Option(id, id)));
    rows('claims', ledger.claims, false); rows('drops', ledger.drops, false); rows('audit', ledger.audit, false);
    for (const kind of ['claims', 'drops', 'audit'] as const) setNext(kind, ledger.next[kind]);
    status.textContent = pendingMatch === 'conflict'
      ? 'The earlier allocation ID exists with different terms. Stop; do not retry or create another allocation until investigated.'
      : resolvedPending
      ? 'Earlier allocation is present in the ledger; the uncertain retry ID is resolved. No payment was sent.'
      : `Private ledger refreshed ${new Date().toLocaleTimeString()}. No payment was sent.`;
  } catch (error) { if (current === generation) status.textContent = `${(error as Error).message}. Existing data, if any, may be stale.`; }
}
$('#admin-login').addEventListener('submit', (e) => {
  e.preventDefault(); token = input('#admin-token').value; input('#admin-token').value = ''; void refresh();
});
$('#admin-refresh').onclick = () => { void refresh(); };
$('#admin-lock').onclick = () => {
  token = ''; generation++; receiptVerificationAvailable = false; $('#admin-work').hidden = true; $('#admin-login').hidden = false;
  for (const id of ['#admin-claims', '#admin-drops', '#admin-audit', '#admin-totals']) $(id).replaceChildren();
  for (const kind of ['claims', 'drops', 'audit'] as const) setNext(kind, null);
  document.querySelectorAll('dialog').forEach((dialog) => { dialog.close(); }); status.textContent = 'Tab locked.';
};
addEventListener('pagehide', () => { $('#admin-lock').click(); });
$('#drop-form').addEventListener('submit', (e) => {
  e.preventDefault(); const form = e.currentTarget as HTMLFormElement;
  const submit = form.querySelector('button')!; if (submit.disabled) return;
  if (pendingConflict) {
    status.textContent = 'The pending allocation ID conflicts with existing ledger terms. Stop and investigate before another allocation.';
    return;
  }
  const candidate = { id: dropId, actorId: input('#drop-actor').value.trim(), amount: input('#drop-amount').value.trim(), revealWhen: $<HTMLSelectElement>('#drop-when').value };
  if (pendingDrop && JSON.stringify(pendingDrop) !== JSON.stringify(candidate)) {
    status.textContent = 'Earlier allocation result is uncertain. Restore the same inputs and retry, or inspect the ledger before starting another allocation.'; return;
  }
  pendingDrop = candidate; submit.disabled = true;
  try { sessionStorage.setItem(pendingKey, JSON.stringify(candidate)); }
  catch { status.textContent = 'This browser cannot preserve the allocation retry ID. No request was sent.'; submit.disabled = false; return; }
  void api('/admin/rewards/drops', candidate).then(() => {
    clearPending(); dropId = crypto.randomUUID(); form.reset(); return refresh();
  }).catch((error: Error & { status?: number }) => {
    if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 415 || error.status === 429) clearPending();
    status.textContent = `${error.message}. ${pendingDrop ? 'Retry unchanged inputs to avoid duplicate allocation.' : 'Correct the input or access token and retry.'}`;
  })
    .finally(() => { submit.disabled = false; });
});
