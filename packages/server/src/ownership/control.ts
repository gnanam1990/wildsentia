import type { EndedLife, LiveLayer } from '../live/liveLayer.js';
import type { HolderKind, OwnershipStore } from './store.js';

/** Who is asking to steer: a person (by their live identity) or an outside agent. */
export interface Steerer { id: string; kind: 'human' | 'agent'; name: string }
export type TakeResult = { ok: true; animalId: string; holder: HolderKind } | { ok: false; reason: string };

/**
 * Congo 1C (spec §3): who steers an owned animal. Its owner (a signed-in person) or an agent
 * the owner authorised may take it; anyone else is refused. A handover releases the old
 * controller in the live layer, swaps the lease in the database, then possesses: there is never
 * a moment with two controllers. Takes, releases and revokes run one at a time.
 */
export class ControlService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: OwnershipStore, private readonly live: LiveLayer) {}

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
      if (!life || life.status !== 'alive') return { ok: false, reason: 'not_owned' };
      const asset = (await this.store.asset(life.assetId))!;
      let holder: HolderKind | null = null;
      if (who.kind === 'human' && (await this.store.accountOfAgent(who.id))?.accountId === asset.ownerAccountId) holder = 'owner';
      else if (who.kind === 'agent' && await this.store.granted(asset.assetId, who.id)) holder = 'agent';
      if (!holder) return { ok: false, reason: 'not_authorised' };
      const mine = this.live.avatars.get(who.id);
      if (mine?.animalId === animalId) return { ok: true, animalId, holder };
      if (mine) return { ok: false, reason: 'already_possessing' };
      // The old controller lets go first; then the lease changes hands; then the new one takes it.
      for (const avatar of [...this.live.avatars.values()]) {
        if (avatar.animalId !== animalId) continue;
        this.live.release(avatar.agentId, holder === 'owner' ? 'Its owner took this animal back.' : 'Its owner handed this animal to another agent.');
        await this.store.endLeaseOf(life.lifeId, avatar.agentId, 'handover');
      }
      const lease = await this.store.openLease(life.lifeId, { kind: holder, id: who.id });
      if (!lease.ok) return { ok: false, reason: lease.reason };
      const taken = this.live.possess(who.id, who.name, { animalId, owner: true }, false);
      if (!taken.ok) {
        await this.store.endLeaseOf(life.lifeId, who.id, 'possess_failed');
        return { ok: false, reason: taken.reason };
      }
      return { ok: true, animalId, holder };
    });
  }

  /** Lets go of the steerer's animal; an owned one's lease ends. Returns false if it held none. */
  release(agentId: string): Promise<boolean> {
    return this.#serial(async () => {
      const avatar = this.live.avatars.get(agentId);
      if (!avatar) return false;
      this.live.release(agentId);
      const life = await this.store.lifeOfAnimal(avatar.animalId);
      if (life) await this.store.endLeaseOf(life.lifeId, agentId, 'released');
      return true;
    });
  }

  /** The owner withdraws an agent's authority: if it is steering their animal, it lets go now. */
  revoke(ownerAccountId: string, assetId: string, agentId: string): Promise<boolean> {
    return this.#serial(async () => {
      const asset = await this.store.asset(assetId);
      if (!asset || asset.ownerAccountId !== ownerAccountId) return false;
      const revoked = await this.store.revoke(assetId, agentId);
      const avatar = this.live.avatars.get(agentId), life = avatar ? await this.store.lifeOfAnimal(avatar.animalId) : null;
      if (avatar && life?.assetId === assetId) {
        this.live.release(agentId, 'The owner withdrew your authority over this animal.');
        await this.store.endLeaseOf(life.lifeId, agentId, 'revoked');
      }
      return revoked;
    });
  }

  /** The live layer ended a possession (death, capture, idling): an owned animal's lease ends with it. */
  ended(life: EndedLife): Promise<void> {
    return this.#serial(async () => {
      const owned = await this.store.lifeOfAnimal(life.animalId);
      if (owned) await this.store.endLeaseOf(owned.lifeId, life.agentId, life.how);
    });
  }
}
