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
  bounty?: { lifeId: string; outcome: 'predator' | 'survived' | 'void'; role: 'target' | 'winner'; payout: { status: 'intent' | 'recorded' } | null; paidToOwner: boolean } | null;
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

/** What a bounty decided on this life means to its owner, in a few words. */
function bountyNote(b: NonNullable<AssetView['bounty']>): string {
  const paid = b.payout ? `payout ${b.payout.status === 'recorded' ? 'recorded' : 'pending'} (SIMULATED)` : null;
  if (b.paidToOwner && paid) return b.role === 'winner' ? `Won a bounty: ${paid}` : `Survived its bounty: ${paid}`;
  if (b.role === 'target' && b.outcome === 'predator') return 'Taken by a predator: the reward went to its owner';
  return 'Bounty outcome verified';
}
const lower = (s: string) => `${s[0]!.toLowerCase()}${s.slice(1)}`;

/**
 * The one state a person sees for an animal: what it is doing now leads (alive, then its
 * cooldown); a bounty decided on this same life rides alongside, or leads once the life is over.
 * A bounty of an earlier life is not this animal's any more.
 */
export function assetState(a: AssetView, now: number): { label: string; tone: Tone; detail?: string } {
  const life = a.life;
  if (!life) return { label: 'Not yet spawned', tone: 'muted' };
  const bounty = a.bounty && a.bounty.lifeId === life.lifeId ? a.bounty : null, note = bounty ? bountyNote(bounty) : null;
  if (life.status === 'alive') {
    const state = liveState(a, life);
    return note ? { ...state, detail: note } : state;
  }
  const cooling = life.status === 'cooldown' && life.cooldownUntil ? Date.parse(life.cooldownUntil) - now : 0;
  if (cooling > 0) return { label: 'Cooldown', tone: 'muted',
    detail: `Can respawn in ${countdown(cooling)}${note ? ` · ${lower(note)}` : life.deathCause ? ` · died of ${life.deathCause}` : ''}` };
  if (bounty) {
    if (bounty.paidToOwner && bounty.payout?.status === 'recorded') return { label: 'Payout recorded (SIMULATED)', tone: 'ok' };
    if (bounty.paidToOwner && bounty.payout?.status === 'intent') return { label: 'Payout pending (SIMULATED)', tone: 'warn' };
    return bounty.role === 'target' && bounty.outcome === 'predator' ? { label: 'Outcome verified', tone: 'muted', detail: note! } : { label: 'Outcome verified', tone: 'muted' };
  }
  return { label: 'Ready to respawn', tone: 'ok' };
}

/** An alive animal's state now. */
function liveState(a: AssetView, life: LifeView): { label: string; tone: Tone; detail?: string } {
  if (life.bountyActive) return { label: 'Bounty active', tone: 'warn' };
  if (life.controller && a.animal && a.animal.steered === false) return { label: 'Disconnected', tone: 'bad', detail: 'Its controller is not steering it now' };
  switch (a.animal?.state) {
    case 'chasing': case 'stalking': return { label: 'Hunting', tone: 'ok' };
    case 'fleeing': return { label: 'Fleeing', tone: 'warn' };
    case 'resting': return { label: 'Resting', tone: 'ok' };
    default: return { label: 'Alive', tone: 'ok' };
  }
}
