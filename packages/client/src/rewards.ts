import { claimRecovery } from './rewardClaimRecovery.js';

interface Drop { id: string; actorId: string; amount: string; network: string; status: string; revealWhen: string }
export class RewardObserver {
  #actorId: string | null = null;
  #token: string | null = null;
  #drops: Drop[] = [];
  #queue: Promise<void> = Promise.resolve();
  #version = 0;
  #configured = false;
  readonly #dialog = document.createElement('dialog');
  readonly #badge = document.querySelector<HTMLButtonElement>('#reward-badge')!;
  readonly #panel = document.querySelector<HTMLElement>('#reward-subject')!;
  readonly #total = document.querySelector<HTMLElement>('#reward-total')!;
  constructor() {
    this.#dialog.className = 'forest-dialog reward-dialog'; document.body.append(this.#dialog);
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
        this.#drops = (response as { drops: Drop[] }).drops;
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
    if (!response.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: response.status });
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
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => this.#dialog.close();
    form.append(choiceLabel, label, note, status, submit, close);
    const selectedActor = this.#actorId;
    let earlierUncertain = false;
    form.onsubmit = async (e) => {
      e.preventDefault(); if (submit.disabled) return;
      const selectedDrop = choice.value, selectedWallet = wallet.value.trim();
      submit.disabled = true; choice.disabled = true; wallet.readOnly = true;
      status.textContent = 'Submitting…';
      try {
        const raw = await this.#post('/rewards/claims', { dropId: selectedDrop, wallet: selectedWallet });
        const result = raw as { claimId: string; amount: string; network: string; status: string };
        status.textContent = `${result.status}: ${result.amount} USDC on ${result.network}. Receipt ${result.claimId}. Keep this receipt; payment is not guaranteed or automatic.`;
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
    this.#dialog.replaceChildren(title, form); this.#dialog.showModal(); wallet.focus();
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
