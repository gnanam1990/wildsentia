/** What the operator's panel shows of Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md). */

/** A 6-decimal USDC amount as people read it: "1 USDC", "0.5 USDC", "12.345678 USDC". */
export function usdc(atomic: string | bigint | null): string {
  if (atomic === null) return '—';
  const n = BigInt(atomic), whole = n / 1_000_000n, frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} USDC`;
}

/** USDC typed by the operator as 6-decimal units, or null if it is not a plain positive amount with at most 6 decimals. */
export function atomicOf(text: string): bigint | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,6}))?\s*$/.exec(text);
  if (!m) return null;
  const atomic = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return atomic > 0n ? atomic : null;
}

/** The bounty windows the panel offers: world time, and about how long that is in real time at the world's rate. */
export const WINDOWS: ReadonlyArray<{ worldSeconds: number; label: string }> = [
  { worldSeconds: 1_200, label: '20 world minutes' },
  { worldSeconds: 6 * 3600, label: '6 world hours' },
  { worldSeconds: 86_400, label: '1 world day' },
  { worldSeconds: 3 * 86_400, label: '3 world days' },
  { worldSeconds: 7 * 86_400, label: '7 world days' },
];

/** "about 1 min 40 s", "about 6 h" of real time for a world-time window, at `rate` world hours a real hour. */
export function realTime(worldSeconds: number, rate = 12): string {
  const s = Math.round(worldSeconds / rate);
  if (s < 3600) { const m = Math.floor(s / 60), r = s % 60; return `about ${m ? `${m} min` : ''}${m && r ? ' ' : ''}${r || !m ? `${r} s` : ''}`; }
  const h = s / 3600;
  return `about ${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/** What happened to a bounty, in plain words. */
export function outcomeText(b: { status: string; outcome?: string | null }): string {
  if (b.status === 'publishing') return 'Publishing on Arc…';
  if (b.status === 'active') return 'Open: the prey is being hunted';
  if (b.status === 'failed') return 'Not published';
  if (b.outcome === 'predator') return b.status === 'paid' ? 'Hunter won: paid' : 'Hunter won: paying…';
  if (b.outcome === 'survived') return b.status === 'paid' ? 'Prey survived: paid' : 'Prey survived: paying…';
  return b.status === 'voided' ? 'Nobody won: back to the pool' : 'Nobody won: returning…';
}

/** A long hash or address, shortened for a table: 0x1234…abcd. */
export function short(hex: string | null | undefined): string {
  return hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : '—';
}

/** Why a random bounty was refused, in plain words. */
export function refusal(code: string): string {
  return ({
    no_candidate: 'No prey to put it on: it needs an agent with a proven wallet steering a hunted, unprotected prey, with another agent\'s predator within 15 km.',
    too_few_alike: 'No prey hidden well enough: a random bounty needs at least three steered animals of the same species in the same region, so hunters cannot tell which one carries it. Drop one on an animal you choose instead.',
    pool_too_small: 'The pool on Arc does not hold that much: fund it first.',
    amount_out_of_range: 'The contract does not allow that amount.',
    bad_window: 'That window is not allowed.',
    bad_amount: 'Enter a plain amount, such as 1 or 0.5.',
    target_taken: 'That animal already carries a bounty.',
    not_found: 'No such animal in this world.',
    dead: 'That animal is dead.',
    protected_species: 'That species is protected: no bounties on it.',
    not_hunted: 'Nothing in this forest hunts it: bounties go on prey.',
    bad_animal: 'That is not an animal id.',
    admin_only: 'That token was refused.',
  } as Record<string, string>)[code] ?? code;
}

/** Who could win a bounty on an animal: its agent if it survives, or only a hunter if it is wild. */
export function whoCanWin(c: { agentId: string | null; wallet: string | null; agentName?: string | null }): string {
  return c.agentId && c.wallet ? `A hunter's agent if it is killed; ${c.agentName ?? c.agentId} (wallet ${short(c.wallet)}) if it survives.`
    : 'Wild: only a hunter\'s agent can win it; if it survives the money goes back to the pool.';
}
