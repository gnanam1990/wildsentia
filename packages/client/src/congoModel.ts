/**
 * Congo 1E: what the player pages show, as pure functions (spec §7): each owned animal's state,
 * cooldown countdowns, and SIMULATED amounts in exact units.
 */
export interface LifeView {
  lifeId: string; animalId: string | null; status: 'alive' | 'cooldown' | 'dead'; spawnedAt: string; diedAt: string | null;
  deathCause: string | null; killerAnimalId: string | null; cooldownUntil: string | null;
  controller: { kind: 'owner' | 'agent'; id: string } | null; bountyActive: boolean;
}
export interface AssetView {
  assetId: string; speciesId: string; status: string; agents: string[]; life: LifeView | null;
  /** The animal as the world has it now (alive lives only). */
  animal?: { state: string; steered?: boolean } | null;
  /** Its last bounty's outcome and payout, if a bounty has been decided on it. */
  bounty?: { outcome: 'predator' | 'survived' | 'void'; role: 'target' | 'winner'; payout: { status: 'intent' | 'recorded' } | null; paidToOwner: boolean } | null;
}
export type Tone = 'ok' | 'warn' | 'muted' | 'bad';

/** "1 h 05 min", "12 min", "under a minute". */
export function countdown(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.floor(ms / 60_000), h = Math.floor(minutes / 60), m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** World seconds left, as world days and hours. */
export function timeLeft(worldSeconds: number): string {
  const days = Math.floor(worldSeconds / 86_400), hours = Math.floor(worldSeconds % 86_400 / 3600);
  return days > 0 ? `${days} world day${days === 1 ? '' : 's'} ${hours} h` : `${hours} world h`;
}

/** An exact integer amount with its decimals, at least two places, marked SIMULATED. */
export function simAmount(atomic: string, decimals: number, token: string): string {
  const digits = atomic.replace(/^0+(?=\d)/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals), fraction = digits.slice(digits.length - decimals).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction} ${token} (SIMULATED)`;
}

/** The one state a person sees for an animal, most important first. */
export function assetState(a: AssetView, now: number): { label: string; tone: Tone; detail?: string } {
  const taken = a.bounty?.role === 'target' && a.bounty.outcome === 'predator' ? 'taken by a predator: the reward went to its owner' : null;
  const cooling = a.life?.status === 'cooldown' && a.life.cooldownUntil ? Date.parse(a.life.cooldownUntil) - now : 0;
  if (a.bounty && (!a.life || a.life.status !== 'alive' || !a.life.bountyActive)) {
    // Only a payout to this owner is theirs to see as pending or recorded.
    if (a.bounty.paidToOwner && a.bounty.payout?.status === 'recorded') return { label: 'Payout recorded (SIMULATED)', tone: 'ok' };
    if (a.bounty.paidToOwner && a.bounty.payout?.status === 'intent') return { label: 'Payout pending (SIMULATED)', tone: 'warn' };
    // While a cooldown runs it leads (the animal cannot respawn yet), with the outcome alongside.
    if (taken && cooling <= 0) return { label: 'Outcome verified', tone: 'muted', detail: `${taken[0]!.toUpperCase()}${taken.slice(1)}` };
    if (!taken && (!a.life || a.life.status === 'alive')) return { label: 'Outcome verified', tone: 'muted' };
  }
  const life = a.life;
  if (!life) return { label: 'Not yet spawned', tone: 'muted' };
  if (cooling > 0) return { label: 'Cooldown', tone: 'muted',
    detail: `Can respawn in ${countdown(cooling)}${taken ? ` · ${taken}` : life.deathCause ? ` · died of ${life.deathCause}` : ''}` };
  if (life.status !== 'alive') return { label: 'Ready to respawn', tone: 'ok' };
  if (life.bountyActive) return { label: 'Bounty active', tone: 'warn' };
  if (life.controller && a.animal && a.animal.steered === false) return { label: 'Disconnected', tone: 'bad', detail: 'Its controller is not steering it now' };
  switch (a.animal?.state) {
    case 'chasing': case 'stalking': return { label: 'Hunting', tone: 'ok' };
    case 'fleeing': return { label: 'Fleeing', tone: 'warn' };
    case 'resting': return { label: 'Resting', tone: 'ok' };
    default: return { label: 'Alive', tone: 'ok' };
  }
}
