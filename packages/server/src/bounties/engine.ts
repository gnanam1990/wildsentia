import { canHunt, type World } from '@vana/sim';
import { landWalkable, patchCentre, regionOfPatch } from '@vana/shared';
import type { OwnershipStore } from '../ownership/store.js';
import { type Bounty, type BountyStore, type Preset } from './store.js';

/**
 * Congo 1D (spec §5): admin presets, validation, publication and adjudication of bounties.
 * The outcome follows the sim's own record of the target's death (cause, killer, world time),
 * against the deadline in world time; settlement goes through a `SettlementAdapter`.
 */

/** Each preset's exact parameters, shown in the admin editor (SIMULATED units, 6 decimals). */
export const PRESETS: Readonly<Record<Preset, { amountAtomic: bigint; windowWorldSeconds: number; label: string }>> = {
  standard: { amountAtomic: 10_000_000n, windowWorldSeconds: 3 * 86_400, label: 'Standard: 10 SIM-USDC, 3 world days' },
  hard: { amountAtomic: 25_000_000n, windowWorldSeconds: 5 * 86_400, label: 'Hard: 25 SIM-USDC, 5 world days' },
  elite: { amountAtomic: 60_000_000n, windowWorldSeconds: 7 * 86_400, label: 'Elite: 60 SIM-USDC, 7 world days' },
};
/** A real elapsed time this many times the window's (at the world's rate) is an outage: held for review. */
export const OUTAGE_FACTOR = 3;
const WATER_WITHIN_M = 1000, PREDATOR_WITHIN_M = 15_000;

/** Records a decided payout. Phase 1 has only the development adapter; a real Arc USDC one is Phase 2. */
export interface SettlementAdapter {
  readonly simulated: boolean;
  settle(bountyId: string): Promise<'recorded' | 'already'>;
}
/** Records payouts in the SIMULATED ledger, once each. */
export class DevSettlementAdapter implements SettlementAdapter {
  readonly simulated = true;
  constructor(private readonly store: BountyStore) {}
  async settle(bountyId: string): Promise<'recorded' | 'already'> { return (await this.store.recordSettlement(bountyId)) ? 'recorded' : 'already'; }
}

export interface ValidationChecks { alive: boolean; funded: boolean; navigable: boolean; water: boolean; food: boolean; predator: boolean }
export type Decision = { bountyId: string; outcome: 'predator' | 'survived' | 'void' | 'on_hold'; payeeWallet: string | null };

export class BountyEngine {
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * `eventsOf` returns the recorded events of these animals between two world times (the bounty's
   * record); `rate` is world hours per real hour.
   */
  constructor(private readonly bounties: BountyStore, private readonly ownership: OwnershipStore, private readonly host: { readonly world: World },
    private readonly settlement: SettlementAdapter, private readonly rate: () => number,
    private readonly eventsOf: (animalIds: string[], from: number, to: number) => Promise<unknown[]> = async () => [],
    /**
     * The world time viewers and live hunters are at: the hour being played trails the world's
     * own clock by up to an hour, and a live kill inside that hour may still beat the deadline.
     */
    private readonly played: () => number = () => this.host.world.now()) {}

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Species that can hunt this one (any of them, owned, may win). */
  eligiblePredators(speciesId: string): string[] {
    const world = this.host.world, prey = world.species.get(speciesId);
    if (!prey) return [];
    const sample = { massKg: prey.body.adultMassKg, lifeStage: 'adult' as const, altitudeM: 0, locomotionMode: 'ground' as const };
    return [...world.species.values()].filter((s) => s.id !== speciesId && canHunt(s, prey, sample)).map((s) => s.id);
  }

  /** A draft on an owned animal's current life, from a preset (an admin may set the amount). */
  async draft(p: { targetAnimalId: string; preset: Preset; amountAtomic?: bigint; windowWorldSeconds?: number }):
    Promise<{ ok: true; bounty: Bounty } | { ok: false; reason: 'not_owned' | 'bad_preset' | 'bad_amount' | 'bad_window' }> {
    const preset = Object.hasOwn(PRESETS, p.preset) ? PRESETS[p.preset] : undefined;
    if (!preset) return { ok: false, reason: 'bad_preset' };
    const amount = p.amountAtomic ?? preset.amountAtomic, window = p.windowWorldSeconds ?? preset.windowWorldSeconds;
    if (amount <= 0n || amount > 10n ** 15n) return { ok: false, reason: 'bad_amount' };
    if (!Number.isSafeInteger(window) || window < 3600 || window > 30 * 86_400) return { ok: false, reason: 'bad_window' };
    const life = await this.ownership.lifeOfAnimal(p.targetAnimalId), animal = this.host.world.animal(p.targetAnimalId);
    if (!life || life.status !== 'alive' || !animal?.alive || animal.assetId !== life.assetId) return { ok: false, reason: 'not_owned' };
    const asset = (await this.ownership.asset(life.assetId))!;
    const bounty = await this.bounties.createDraft({ preset: p.preset, targetLifeId: life.lifeId, targetAnimalId: animal.id, targetSpeciesId: animal.speciesId,
      targetRegion: regionOfPatch(this.host.world.grid, animal.patchId), targetAssetId: asset.assetId, targetOwnerAccountId: asset.ownerAccountId,
      targetOwnerWallet: asset.ownerWallet, amountAtomic: amount, decimals: 6, windowWorldSeconds: window,
      eligiblePredators: this.eligiblePredators(animal.speciesId), rules: { preset: preset.label, ownerPredatorNeverWins: true, deadlineIn: 'world time' } });
    return { ok: true, bounty };
  }

  /** The checks a bounty must pass to publish; each failure named. */
  async validate(bountyId: string): Promise<{ ok: boolean; checks: ValidationChecks } | null> {
    const b = await this.bounties.get(bountyId);
    if (!b) return null;
    const world = this.host.world, animal = world.animal(b.targetAnimalId), life = await this.ownership.life(b.targetLifeId);
    const alive = !!(animal?.alive && life?.status === 'alive' && animal.assetId === b.targetAssetId);
    const here = animal ? world.patches[animal.patchId] : undefined, pos = animal?.position;
    const near = (radius: number, test: (id: number) => boolean) => !!pos && world.patches.some((p) => {
      const c = patchCentre(world.grid, p.id);
      return Math.abs(c.x - pos.x) <= radius && Math.abs(c.z - pos.z) <= radius && Math.hypot(c.x - pos.x, c.z - pos.z) <= radius && test(p.id);
    });
    const cfg = animal ? world.species.get(animal.speciesId) : undefined;
    const checks: ValidationChecks = {
      alive,
      funded: (await this.ownership.poolBalance()) >= b.amountAtomic,
      navigable: landWalkable(here),
      water: near(WATER_WITHIN_M, (id) => world.patches[id]!.habitat === 'water' || world.patches[id]!.waterVolume > 0),
      food: !!here && (cfg?.hunting ? world.agents.some((a) => a.alive && cfg.hunting?.preferredPrey.includes(a.speciesId))
        : here.plant.grass + here.plant.browse > 0),
      predator: !!pos && world.agents.some((a) => a.alive && b.eligiblePredators.includes(a.speciesId) && a.position
        && Math.hypot(a.position.x - pos.x, a.position.z - pos.z) <= PREDATOR_WITHIN_M),
    };
    const ok = Object.values(checks).every(Boolean);
    await this.bounties.setValidation(bountyId, { ...checks }, ok);
    return { ok, checks };
  }

  /** Publishes a validated bounty, its deadline counted from now in world time. */
  async publish(bountyId: string): Promise<{ ok: true; bounty: Bounty } | { ok: false; reason: string }> {
    const check = await this.validate(bountyId);
    if (!check) return { ok: false, reason: 'not_found' };
    if (!check.checks.alive) return { ok: false, reason: 'target_not_alive' };
    if (!check.checks.funded) return { ok: false, reason: 'unfunded' };
    if (!check.ok) return { ok: false, reason: 'not_validated' };
    return this.bounties.publish(bountyId, this.host.world.now());
  }

  /**
   * Decides every active bounty whose target has died or whose deadline has passed, then settles.
   * The sim's single event order decides: a kill at or before the deadline beats survival.
   */
  adjudicate(now: Date = new Date()): Promise<Decision[]> {
    return this.#serial(async () => {
      const decisions: Decision[] = [];
      // A bounty an earlier world left open can never be decided here: its reservation returns.
      for (const b of await this.bounties.activeElsewhere()) {
        if (await this.bounties.decide(b.bountyId, { outcome: 'void', payeeWallet: null, winnerAnimalId: null, worldTime: b.publishedWorldTime ?? 0 }))
          decisions.push({ bountyId: b.bountyId, outcome: 'void', payeeWallet: null });
      }
      for (const b of await this.bounties.active()) {
        if (b.status !== 'active') continue;
        const decision = await this.#decide(b, now);
        if (decision) decisions.push(decision);
      }
      await this.#settlePending();
      return decisions;
    });
  }

  async #decide(b: Bounty, now: Date): Promise<Decision | null> {
    const world = this.host.world, animal = world.animal(b.targetAnimalId), deadline = b.deadlineWorldTime!;
    const survives = async (): Promise<Decision | null> => {
      // Deadlines are in world time; an outage that stretched the real window far beyond its due is held for review.
      const dueMs = b.windowWorldSeconds / 3600 / Math.max(1e-9, this.rate()) * 3_600_000;
      if (!b.holdCleared && b.publishedAt && now.getTime() - b.publishedAt.getTime() > OUTAGE_FACTOR * dueMs) {
        await this.bounties.hold(b.bountyId, 'outage: the real time far exceeded the world-time window');
        return { bountyId: b.bountyId, outcome: 'on_hold', payeeWallet: null };
      }
      return this.#close(b, { outcome: 'survived', payeeWallet: b.targetOwnerWallet, winnerAnimalId: b.targetAnimalId, worldTime: deadline });
    };
    // Alive at the deadline only once the hour being played has reached it: a live kill may still come before.
    if (animal?.alive && animal.assetId === b.targetAssetId) return world.now() >= deadline && this.played() >= deadline ? survives() : null;
    const death = animal && !animal.alive ? animal.ownedDeath : undefined;
    if (death && death.at > deadline) return survives();
    if (death?.cause === 'predation' && death.killerId) {
      const winner = await this.#ownedKiller(b, death.killerId, death.at);
      if (winner) return this.#close(b, { outcome: 'predator', payeeWallet: winner.wallet, winnerAnimalId: death.killerId, worldTime: death.at });
    }
    // Another cause, an unowned or ineligible killer, the owner's own predator, or a lost animal: the reservation returns.
    return this.#close(b, { outcome: 'void', payeeWallet: null, winnerAnimalId: null, worldTime: death?.at ?? world.now() });
  }

  /** The killer's owning wallet, if it was an eligible owned animal alive at the kill, not owned by the target's owner. */
  async #ownedKiller(b: Bounty, killerId: string, at: number): Promise<{ wallet: string } | null> {
    const killer = this.host.world.animal(killerId), life = await this.ownership.lifeOfAnimal(killerId);
    if (!killer || !life || killer.assetId !== life.assetId || !b.eligiblePredators.includes(killer.speciesId)) return null;
    if ((life.spawnedWorldTime ?? Infinity) > at || (life.status !== 'alive' && (life.diedWorldTime ?? -Infinity) < at)) return null;
    const asset = await this.ownership.asset(life.assetId);
    if (!asset || asset.ownerAccountId === b.targetOwnerAccountId) return null;
    return { wallet: asset.ownerWallet };
  }

  async #close(b: Bounty, d: { outcome: 'predator' | 'survived' | 'void'; payeeWallet: string | null; winnerAnimalId: string | null; worldTime: number }): Promise<Decision | null> {
    if (!(await this.bounties.decide(b.bountyId, d))) return null;
    const actors = [b.targetAnimalId, ...(d.outcome === 'predator' && d.winnerAnimalId ? [d.winnerAnimalId] : [])];
    const events = await this.eventsOf(actors, b.publishedWorldTime ?? 0, d.worldTime).catch(() => []);
    await this.bounties.saveRecord(b.bountyId, events);
    return { bountyId: b.bountyId, outcome: d.outcome, payeeWallet: d.payeeWallet };
  }

  /** Records every intended payout not yet recorded (also after a restart). */
  settlePending(): Promise<number> { return this.#serial(() => this.#settlePending()); }

  async #settlePending(): Promise<number> {
    let recorded = 0;
    for (const s of await this.bounties.pendingSettlements()) if ((await this.settlement.settle(s.bountyId)) === 'recorded') recorded++;
    return recorded;
  }
}
