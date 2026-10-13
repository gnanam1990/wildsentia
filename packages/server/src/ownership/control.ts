import type { EndedLife, LiveLayer } from '../live/liveLayer.js';
import type { HolderKind, OwnershipStore } from './store.js';

/** Who is asking to steer: a person (by their live identity) or an outside agent. */
export interface Steerer { id: string; kind: 'human' | 'agent'; name: string }
export type TakeResult = { ok: true; animalId: string; holder: HolderKind } | { ok: false; reason: string };

/** What control needs of the world. */
export interface ControlWorld {
  /** The asset the world's animal carries, if any (the sim's own record of ownership). */
  assetOf(animalId: string): string | undefined;
  /** Why no holder at all could steer the animal now (up a tree, under water…), setting aside who holds it. */
  block(animalId: string): string | null;
  /** Runs work between world steps, never inside one (the live layer refuses changes during a step). */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Congo 1C (spec §3): who steers an owned animal. Its owner (a signed-in person) or an agent
 * the owner authorised may take it; anyone else is refused. A take that cannot succeed changes
 * nothing; one that can releases the old controller, swaps the lease, then possesses, between
 * world steps: there is never a moment with two controllers. Calls run one at a time.
 */
export class ControlService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: OwnershipStore, private readonly live: LiveLayer, private readonly world: ControlWorld) {}

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Resolves when everything queued so far has run. */
  idle(): Promise<void> { return this.#serial(async () => undefined); }

  take(who: Steerer, animalId: string): Promise<TakeResult> {
    return this.#serial(async () => {
      const life = await this.store.lifeOfAnimal(animalId);
      // The database's life and the world's animal must name the same asset.
      if (!life || life.status !== 'alive' || this.world.assetOf(animalId) !== life.assetId) return { ok: false, reason: 'not_owned' };
      const asset = (await this.store.asset(life.assetId))!;
      let holder: HolderKind | null = null;
      if (who.kind === 'human' && (await this.store.accountOfAgent(who.id))?.accountId === asset.ownerAccountId) holder = 'owner';
      else if (who.kind === 'agent' && await this.store.granted(asset.assetId, who.id)) holder = 'agent';
      if (!holder) return { ok: false, reason: 'not_authorised' };
      const kind = holder;
      return this.world.exclusive(async (): Promise<TakeResult> => {
        if (this.live.avatars.get(who.id)?.animalId === animalId) return { ok: true, animalId, holder: kind };
        // Refused before anyone lets go: a take that cannot succeed leaves the current holder steering.
        const refused = this.live.possessBlock(who.id) ?? this.world.block(animalId) ?? (this.live.wild.has(animalId) ? 'in_a_chase' : null);
        if (refused) return { ok: false, reason: refused };
        for (const avatar of [...this.live.avatars.values()]) {
          if (avatar.animalId !== animalId) continue;
          this.live.release(avatar.agentId, kind === 'owner' ? 'Its owner took this animal back.' : 'Its owner handed this animal to another agent.');
          await this.store.endLeaseOf(life.lifeId, avatar.agentId, 'handover');
        }
        const lease = await this.store.openLease(life.lifeId, { kind, id: who.id });
        if (!lease.ok) return { ok: false, reason: lease.reason };
        let taken: ReturnType<LiveLayer['possess']>;
        try { taken = this.live.possess(who.id, who.name, { animalId, owner: true }, false); }
        catch (error) { await this.store.endLeaseOf(life.lifeId, who.id, 'possess_failed'); throw error; }
        if (!taken.ok) {
          await this.store.endLeaseOf(life.lifeId, who.id, 'possess_failed');
          return { ok: false, reason: taken.reason };
        }
        return { ok: true, animalId, holder: kind };
      });
    });
  }

  /** Lets go of the steerer's animal; an owned one's lease ends. Returns false if it held none. */
  release(agentId: string): Promise<boolean> {
    return this.#serial(() => this.world.exclusive(async () => {
      const avatar = this.live.avatars.get(agentId);
      if (!avatar) return false;
      this.live.release(agentId);
      const life = await this.store.lifeOfAnimal(avatar.animalId);
      if (life) await this.store.endLeaseOf(life.lifeId, agentId, 'released');
      return true;
    }));
  }

  /** The owner withdraws an agent's authority: if it is steering their animal, it lets go at once. */
  revoke(ownerAccountId: string, assetId: string, agentId: string): Promise<boolean> {
    return this.#serial(async () => {
      const asset = await this.store.asset(assetId);
      if (!asset || asset.ownerAccountId !== ownerAccountId) return false;
      return this.world.exclusive(async () => {
        const revoked = await this.store.revoke(assetId, agentId);
        const avatar = this.live.avatars.get(agentId), life = avatar ? await this.store.lifeOfAnimal(avatar.animalId) : null;
        if (avatar && life?.assetId === assetId) {
          this.live.release(agentId, 'The owner withdrew your authority over this animal.');
          await this.store.endLeaseOf(life.lifeId, agentId, 'revoked');
        }
        return revoked;
      });
    });
  }

  /** The live layer ended a possession (death, capture, idling): an owned animal's lease ends with it. */
  ended(life: EndedLife): Promise<void> {
    return this.#serial(async () => {
      // Already steering it again (a later take): this notice is of an earlier possession.
      if (this.live.avatars.get(life.agentId)?.animalId === life.animalId) return;
      const owned = await this.store.lifeOfAnimal(life.animalId);
      if (owned) await this.store.endLeaseOf(owned.lifeId, life.agentId, life.how, new Date(life.endedAt));
    });
  }
}
