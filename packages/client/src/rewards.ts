import { claimRecovery } from './rewardClaimRecovery.js';
import { browserClaimStore as storage, describeClaimStatus, forgetClaim, loadClaims, rememberClaim, type StoredClaim } from './rewardReceipts.js';

interface Drop { id: string; actorId: string; amount: string; network: string; status: string; revealWhen: string }
export class RewardObserver {
  #actorId: string | null = null;
  #token: string | null = null;
  #drops: Drop[] = [];
  #queue: Promise<void> = Promise.resolve();
  #version = 0;
  #configured = false;
  /** When the server will accept a claim for the watched animal (performance.now() time). */
  #claimableAt = 0;
  readonly #dialog = document.createElement('dialog');
  readonly #badge = document.querySelector<HTMLButtonElement>('#reward-badge')!;
  readonly #panel = document.querySelector<HTMLElement>('#reward-subject')!;
  readonly #total = document.querySelector<HTMLElement>('#reward-total')!;
  readonly #mine = document.createElement('button');
  constructor() {
    this.#dialog.className = 'forest-dialog reward-dialog'; document.body.append(this.#dialog);
    this.#mine.id = 'reward-mine'; this.#mine.type = 'button'; this.#mine.setAttribute('aria-haspopup', 'dialog');
    this.#mine.onclick = () => this.openMyClaims();
    this.#total.after(this.#mine); this.#refreshMine();
    this.#badge.onclick = () => this.openClaim();
    this.#badge.ondblclick = () => this.openClaim();
    void this.summary();
    setInterval(() => { if (!document.hidden) { void this.summary(); this.watch(this.#actorId); } }, 15_000);
  }
  async summary(): Promise<void> {
    try {
      const response = await fetch('/api/rewards/summary');
      if (response.status === 503) {
        this.#configured = false; this.#drops = []; this.#badge.hidden = true; this.#panel.replaceChildren();
        this.#total.textContent = 'Rewards not enabled'; return;
      }
      if (!response.ok) throw new Error();
      const body = await response.json() as { available: string; reserved: string; network: string };
      const was = this.#configured; this.#configured = true;
      this.#total.textContent = `${body.available} USDC unclaimed · ${body.reserved} reserved · ${body.network} · allocations, not verified funds`;
      this.#total.title = 'Admin allocations, not verified deposited funds. First accepted claim immediately reserves the amount. Manual payments.';
      if (!was) this.watch(this.#actorId);
    } catch { this.#total.textContent = 'Reward totals unavailable'; }
  }
  watch(id: string | null): Promise<void> {
    const changed = id !== this.#actorId;
    this.#actorId = id; const version = ++this.#version;
    if (changed) { this.#drops = []; this.#badge.hidden = true; this.#panel.replaceChildren(); if (this.#dialog.open) this.#dialog.close(); }
    if (!this.#configured) return Promise.resolve();
    this.#queue = this.#queue.then(async () => {
      if (version !== this.#version) return;
      try {
        if (!this.#token) {
          const session = await fetch('/api/rewards/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!session.ok) throw new Error(); this.#token = (await session.json() as { token: string }).token;
        }
        const response = await this.#post('/rewards/watch', { actorId: id });
        if (version !== this.#version) return;
        const watched = response as { drops: Drop[]; claimableInSeconds?: number };
        this.#drops = watched.drops;
        this.#claimableAt = performance.now() + Math.max(0, watched.claimableInSeconds ?? 0) * 1000;
        this.#panel.replaceChildren(); this.#badge.hidden = !this.#drops.length;
        if (this.#drops.length) {
          const drop = this.#drops[0]!;
          const button = document.createElement('button'); button.textContent = `Claim ${drop.amount} USDC · ${drop.network}`;
          button.onclick = () => this.openClaim(); this.#panel.append(button);
          const note = document.createElement('p'); note.className = 'hint';
          note.textContent = drop.revealWhen === 'carcass' ? 'Reward on checkpointed remains. Recorded animation may show an earlier living animal.'
            : 'Reward belongs to the current checkpoint, not historical replay.';
          this.#panel.append(note);
          this.#badge.textContent = `${drop.amount} USDC · Claim reward`;
        }
      } catch { if (version === this.#version) { this.#drops = []; this.#badge.hidden = true; this.#panel.textContent = 'Reward discovery unavailable; try following again.'; } }
    });
    return this.#queue;
  }
  async #post(path: string, body: unknown): Promise<unknown> {
    const requestToken = this.#token;
    const response = await fetch(`/api${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestToken ?? ''}` }, body: JSON.stringify(body) });
    if (response.status === 401 && requestToken === this.#token) this.#token = null;
    const data = await response.json() as { error?: string };
    if (!response.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: response.status,
      retryAfterSeconds: (data as { retryAfterSeconds?: number }).retryAfterSeconds });
    return data;
  }
  openClaim(): void {
    if (this.#dialog.open || !this.#drops.length) return;
    const drops = [...this.#drops];
    const title = document.createElement('h2'); title.id = 'claim-title'; title.textContent = 'Request an observer reward';
    this.#dialog.setAttribute('aria-labelledby', title.id);
    const form = document.createElement('form');
    const choiceLabel = document.createElement('label'); choiceLabel.textContent = 'Reward amount and network';
    const choice = document.createElement('select');
    for (const d of drops) choice.add(new Option(`${d.amount} USDC · ${d.network} · ${d.actorId}`, d.id));
    choiceLabel.append(choice);
    const label = document.createElement('label'); label.textContent = 'Receiving wallet address';
    const wallet = document.createElement('input'); wallet.required = true; wallet.maxLength = 100;
    wallet.autocomplete = 'off'; wallet.spellcheck = false; wallet.setAttribute('autocapitalize', 'none'); label.append(wallet);
    const note = document.createElement('p'); note.textContent = 'Use your receiving wallet on Base. Only the administrator sees this address. No wallet connection, signature or fee is required. The first accepted claim immediately reserves this reward. The administrator sends USDC manually. Address syntax checks do not prove ownership or that a wallet can receive USDC. Check carefully: submitted addresses cannot be edited.';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Reserve reward';
    // Claims open only after real watching time; count it down instead of letting a claim fail.
    const waitNote = document.createElement('p'); waitNote.className = 'hint';
    const tick = (): void => {
      const left = Math.ceil((this.#claimableAt - performance.now()) / 1000);
      if (left > 0 && this.#dialog.open) {
        waitNote.textContent = `Keep watching this animal: you can claim in ${left} s.`;
        submit.disabled = true; setTimeout(tick, 1000);
      } else if (waitNote.textContent) { waitNote.textContent = ''; if (!wallet.readOnly) submit.disabled = false; }
    };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => this.#dialog.close();
    form.append(choiceLabel, label, note, waitNote, status, submit, close);
    const selectedActor = this.#actorId;
    let earlierUncertain = false;
    form.onsubmit = async (e) => {
      e.preventDefault(); if (submit.disabled) return;
      const selectedDrop = choice.value, selectedWallet = wallet.value.trim();
      submit.disabled = true; choice.disabled = true; wallet.readOnly = true;
      status.textContent = 'Submitting…';
      try {
        const raw = await this.#post('/rewards/claims', { dropId: selectedDrop, wallet: selectedWallet });
        const result = raw as { claimId: string; amount: string; network: string; status: string; receipt?: string };
        status.textContent = `${result.status}: ${result.amount} USDC on ${result.network}. Claim ${result.claimId}`
          + (result.receipt ? `, receipt ${result.receipt}. This browser keeps it under "My reward claims"; save it to check the claim elsewhere.` : '.')
          + ' Payment is not guaranteed or automatic.';
        if (result.receipt) {
          rememberClaim(storage, { claimId: result.claimId, receipt: result.receipt, amount: result.amount, network: result.network,
            animalId: selectedActor ?? '', claimedAt: new Date().toISOString() });
          this.#refreshMine();
        }
        this.#drops = this.#drops.filter((drop) => drop.id !== selectedDrop);
        this.#badge.hidden = true; this.#panel.replaceChildren();
        wallet.value = ''; void this.summary(); this.watch(this.#actorId);
      } catch (error) {
        const failure = error as Error & { status?: number };
        const recovery = claimRecovery(failure.status, earlierUncertain);
        if (recovery === 'renew_selection') {
          status.textContent = 'Observer session expired before this claim was accepted. Refreshing the selected animal; no claim is being resubmitted.';
          if (selectedActor === this.#actorId) await this.watch(selectedActor);
          if (selectedActor === this.#actorId && this.#token && this.#drops.some((drop) => drop.id === selectedDrop)) {
            status.textContent = 'Observer session renewed. Review the same wallet and submit again; no claim was sent automatically.';
            submit.disabled = false; choice.disabled = false; wallet.readOnly = false;
          } else status.textContent = 'Could not restore this reward selection. Close the form and follow the animal again; no claim was resubmitted.';
        } else if (recovery === 'retry_exact') {
          earlierUncertain = true;
          submit.disabled = false; submit.textContent = 'Retry exact claim';
          status.textContent = 'Claim result is uncertain. Keep this tab open and retry only this exact reward and wallet; do not create a new claim.';
        } else if (recovery === 'correct_input') {
          status.textContent = 'The wallet or claim details were rejected before reservation. Correct the address and submit again.';
          submit.disabled = false; choice.disabled = false; wallet.readOnly = false;
        } else if (recovery === 'keep_watching') {
          this.#claimableAt = performance.now() + Math.max(1, Number((failure as { retryAfterSeconds?: number }).retryAfterSeconds ?? 5)) * 1000;
          status.textContent = 'Keep watching this animal a little longer, then submit again. Nothing was reserved.';
          choice.disabled = false; wallet.readOnly = false; tick();
        } else if (failure.message === 'wallet_daily_limit') {
          status.textContent = 'This wallet has already won a reward in the last 24 hours. Nothing was reserved.';
          submit.disabled = false; choice.disabled = false; wallet.readOnly = false;
        } else if (failure.message === 'client_daily_limit') {
          status.textContent = 'Your network has reached today\'s reward limit. Nothing was reserved; try again tomorrow.';
        } else if (recovery === 'wait') {
          status.textContent = 'Too many requests. Wait a minute, then retry this exact reward and wallet.';
          submit.disabled = false;
        } else if (recovery === 'refresh_reward') {
          status.textContent = 'This reward or reservation changed. Close the form and refresh the selected animal before another attempt.';
          void this.watch(this.#actorId);
        } else {
          status.textContent = 'A previous claim result was uncertain, and this retry cannot establish its outcome. Do not submit a new claim; ask the administrator to reconcile this exact reward and wallet.';
        }
      }
    };
    this.#dialog.replaceChildren(title, form); this.#dialog.showModal(); wallet.focus(); tick();
  }

  #refreshMine(): void {
    const count = loadClaims(storage).length;
    this.#mine.hidden = count === 0;
    this.#mine.textContent = `My reward claims (${count})`;
  }

  /** The claims made in this browser, each checked with the server by its receipt. */
  openMyClaims(): void {
    if (this.#dialog.open) return;
    const title = document.createElement('h2'); title.id = 'my-claims-title'; title.textContent = 'My reward claims';
    this.#dialog.setAttribute('aria-labelledby', title.id);
    const list = document.createElement('ul'); list.className = 'reward-claims';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => this.#dialog.close();
    const render = (claims: StoredClaim[]): void => {
      list.replaceChildren();
      if (!claims.length) { const empty = document.createElement('li'); empty.textContent = 'No claims saved in this browser.'; list.append(empty); }
      for (const claim of claims) {
        const item = document.createElement('li');
        const head = document.createElement('strong'); head.textContent = `${claim.amount} USDC · ${claim.network} · ${claim.animalId}`;
        const state = document.createElement('p'); state.setAttribute('role', 'status'); state.textContent = 'Checking…';
        const ids = document.createElement('p'); ids.className = 'hint';
        ids.textContent = `Claim ${claim.claimId} · receipt ${claim.receipt}`;
        const forget = document.createElement('button'); forget.type = 'button'; forget.textContent = 'Forget in this browser';
        forget.onclick = () => { render(forgetClaim(storage, claim.claimId)); this.#refreshMine(); };
        item.append(head, state, ids, forget); list.append(item);
        void fetch(`/api/rewards/claims/${claim.claimId}`, { headers: { Authorization: `Bearer ${claim.receipt}` } })
          .then(async (response) => {
            if (!response.ok) { state.textContent = response.status === 404 ? 'Not found on this server.' : 'Status unavailable; try later.'; return; }
            const body = await response.json() as { status: string; wallet: string; payment: { transactionRef: string; verified: boolean } | null };
            state.textContent = `${describeClaimStatus(body.status)} Wallet ${body.wallet}.`;
            if (body.payment) {
              const link = document.createElement('a');
              link.href = `https://basescan.org/tx/${body.payment.transactionRef}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
              link.textContent = `${body.payment.verified ? 'Verified' : 'Reported'} transaction ${body.payment.transactionRef.slice(0, 10)}…`;
              state.append(' ', link);
            }
          })
          .catch(() => { state.textContent = 'Status unavailable; try later.'; });
      }
    };
    render(loadClaims(storage));
    this.#dialog.replaceChildren(title, list, close); this.#dialog.showModal(); close.focus();
  }
  position(x: number, y: number, visible: boolean, renderedDead = false): void {
    const eligible = this.#drops.find((drop) => drop.revealWhen !== 'carcass' || renderedDead);
    this.#badge.hidden = !visible || !eligible;
    if (!this.#badge.hidden && eligible) {
      this.#badge.textContent = `${eligible.amount} USDC · Claim reward`;
      this.#badge.style.left = `${x}px`; this.#badge.style.top = `${y}px`;
    }
  }
}
