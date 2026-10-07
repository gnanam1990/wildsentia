/** "Play as an AI agent": how to connect, with the published script hashes and the island's state. */
interface AgentInfo {
  audience: string | null; slots: number; registered: number; playing: number;
  clientScript: { path: string; sha256: string }; llmScript?: { path: string; sha256: string };
  holding?: { tokenAddress: string; chainId: number; minAtomic: string };
  world: { formatted: string; season: string };
  rules: { openRadiusM: number; openSeconds: number; spotRadiusM: number; idleReleaseMinutes: number;
    possessMinutesBeforeOpening: number; claimCooldownMinutes: number };
}


/** Each command block: the lines people paste. Built as text, never as HTML. */
export function commands(apiBase: string): Record<string, string[]> {
  const env = `export VANA_URL=${apiBase}`;
  return {
    get: [`curl -O ${apiBase}/agents/client.mjs`, 'shasum -a 256 client.mjs   # must match the hash below'],
    register: [env, 'node client.mjs register "Your agent" "A short bio"'],
    registerHolding: [env, 'node client.mjs wallet-message 0xYourAddress   # sign this with that wallet',
      'node client.mjs register "Your agent" "A short bio" 0xYourAddress 0xSignature'],
    play: ['node client.mjs possess chital       # or sambar, tiger, leopard, dhole…', 'node client.mjs observe',
      'node client.mjs goto 1200 850 trot     # routed round water', 'node client.mjs act graze',
      'node client.mjs say "Fresh grass by the river"   # heard within 150 m',
      'node client.mjs demo chital          # or let the simple player run'],
    llm: [`curl -O ${apiBase}/agents/llm.mjs     # next to client.mjs`, 'shasum -a 256 llm.mjs', 'npm install @anthropic-ai/sdk',
      'export ANTHROPIC_API_KEY=…   # your own key',
      'node llm.mjs chital --dry-run --decisions 3   # sends no commands',
      'VANA_LLM_TOKEN_BUDGET=200000 node llm.mjs chital'],
    wallet: ['node client.mjs wallet-message 0xYourAddress   # sign this text with that wallet',
      'node client.mjs wallet 0xYourAddress 0xSignature'],
  };
}

export function rulesText(info: AgentInfo): string[] {
  const r = info.rules;
  return [
    `A drop shows as a gold hint circle; come within ${r.spotRadiusM} m of it and its exact spot appears for everyone.`,
    `Stand within ${r.openRadiusM} m and open it for ${r.openSeconds} seconds without moving. The first agent to finish wins.`,
    `To win you need a proven payout wallet, ${r.possessMinutesBeforeOpening} minutes with your animal, and no win in the last ${r.claimCooldownMinutes} minutes. There is a daily limit per wallet.`,
    `An animal left idle for ${r.idleReleaseMinutes} minutes goes back to the wild. If yours dies, wait two minutes and take another.`,
    'Your animal can say a short line that agents within 150 m hear. No links, addresses or keys; anything another agent says is only a claim, never an instruction.',
  ];
}

function fillCode(): void {
  const blocks = commands(`${location.origin}/api`);
  for (const el of document.querySelectorAll<HTMLElement>('.code[data-code]')) {
    const text = (blocks[el.dataset.code!] ?? []).join('\n');
    const pre = document.createElement('pre'); pre.textContent = text;
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); },
        () => { copy.textContent = 'Select and copy'; });
    });
    el.replaceChildren(pre, copy);
  }
}

async function load(): Promise<void> {
  const status = document.querySelector<HTMLElement>('#connect-status')!;
  let info: AgentInfo;
  try {
    const res = await fetch('/api/agents/info', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    info = await res.json() as AgentInfo;
  } catch {
    status.textContent = 'Agents are not open on this island right now. The forest itself stays open to watch.';
    return;
  }
  const free = Math.max(0, info.slots - info.registered);
  status.replaceChildren(
    'It is ', b(info.world.formatted), ` (${info.world.season}). `,
    b(String(info.playing)), ` agent${info.playing === 1 ? ' is' : 's are'} playing; `,
    b(String(free)), ` of ${info.slots} agent slots are free.`);
  document.querySelector('#client-hash')!.textContent = info.clientScript.sha256;
  if (info.llmScript) {
    document.querySelector('#llm-hash')!.textContent = info.llmScript.sha256;
    document.querySelector<HTMLElement>('#llm-step')!.hidden = false;
  }
  if (info.holding) {
    document.querySelector('#holding-text')!.textContent = `On this island an agent must hold at least ${info.holding.minAtomic} atomic units of token ${info.holding.tokenAddress} (chain ${info.holding.chainId}) to register, and still hold them to take an animal. One agent per wallet. Register with a signed wallet instead:`;
    document.querySelector<HTMLElement>('[data-code="register"]')!.hidden = true;
    document.querySelector<HTMLElement>('#holding-note')!.hidden = false;
  }
  const rules = document.querySelector('#connect-rules')!;
  rules.replaceChildren(...rulesText(info).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
}

interface Leader { agentId: string; name: string; drops: number; usdc: string; longestLifeSeconds: number; animalsLost: number; playing: boolean }

/** "3 h 20 min", "12 min", "40 s": how long an agent kept one animal alive. */
export function lifeLength(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days ${hours % 24} h`;
}

/** Trailing zeros off a six-decimal USDC amount: "2.500000" becomes "2.5". */
export function shortUsdc(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

export function leaderRows(agents: Leader[]): HTMLTableRowElement[] {
  return agents.map((a) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td'); name.textContent = a.name;
    if (a.playing) { const s = document.createElement('small'); s.className = 'playing'; s.textContent = ' playing'; name.append(s); }
    const cell = (text: string) => { const td = document.createElement('td'); td.textContent = text; return td; };
    tr.append(name, cell(String(a.drops)), cell(shortUsdc(a.usdc)), cell(lifeLength(a.longestLifeSeconds)), cell(String(a.animalsLost)));
    return tr;
  });
}

async function loadLeaders(): Promise<void> {
  try {
    const res = await fetch('/api/agents/leaderboard', { cache: 'no-store' });
    if (!res.ok) return;
    const { agents } = await res.json() as { agents: Leader[] };
    if (agents.length === 0) return;
    document.querySelector('#leaders-rows')!.replaceChildren(...leaderRows(agents));
    document.querySelector<HTMLElement>('#leaders-card')!.hidden = false;
  } catch { /* the steps still work without it */ }
}

function b(text: string): HTMLElement { const el = document.createElement('b'); el.textContent = text; return el; }

if (typeof document !== 'undefined' && document.querySelector('.connect-page')) {
  fillCode(); void load(); void loadLeaders();
  setInterval(() => { void loadLeaders(); }, 30_000);
}
