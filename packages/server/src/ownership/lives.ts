import { randomInt } from 'node:crypto';
import type { World } from '@vana/sim';
import type { OwnershipStore } from './store.js';
import type { OwnershipConfig } from './purchase.js';

/** What the life service needs of the world's host: its world, and turns between steps. */
export interface OwnedWorldHost {
  readonly world: World;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

/** A reserved life with no animal after this long was never spawned (a crash between the two). */
const UNSPAWNED_LOST_MS = 120_000;

export type SpawnResult = { ok: true; lifeId: string; animalId: string; patchId: number }
  | { ok: false; reason: 'not_owner' | 'not_active' | 'already_alive' | 'cooldown' | 'alive_limit' | 'no_safe_ground' };

/**
 * Congo 1C (spec §3): each life of an owned asset follows its sim animal. A spawn reserves the
 * life in the database first, then places the animal; reconciling ends every life whose animal
 * has died (once, with its cause and killer) or is missing, and frees any owned animal whose life
 * has already ended (a restart that rolled the world back). Spawns and reconciles take turns.
 */
export class LifeService {
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * `checkpoint` saves the world after a spawn, so a crash cannot roll the new animal back (and
   * hand its id to a later animal).
   */
  constructor(private readonly store: OwnershipStore, private readonly host: OwnedWorldHost, private readonly config: OwnershipConfig,
    private readonly checkpoint: () => Promise<void> = async () => undefined) {}

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The cooldown after a death of this species: its own, else the world's default. */
  cooldownMs(speciesId: string): number { return this.config.cooldownMs[speciesId] ?? this.config.cooldownMs.default; }

  /** A new life of the owner's asset, on ground its kind lives on with no hunter of it near. */
  spawn(ownerAccountId: string, assetId: string, now: Date = new Date()): Promise<SpawnResult> {
    return this.#serial(async () => {
      const asset = await this.store.asset(assetId);
      if (!asset || asset.ownerAccountId !== ownerAccountId) return { ok: false, reason: 'not_owner' } as const;
      const reserved = await this.store.openLife({ assetId, ownerAccountId, maxAlive: this.config.maxAlivePerOwner, now });
      if (!reserved.ok) return reserved;
      let placed: { animalId: string; patchId: number; worldTime: number } | null = null;
      try {
        placed = await this.host.exclusive(async () => {
          const safe = this.host.world.safeSpawnPatches(asset.speciesId, this.config.spawnPredatorDistanceM);
          if (safe.length === 0) return null;
          const patchId = safe[randomInt(safe.length)]!;
          const animal = this.host.world.spawnOwned(asset.speciesId, patchId, assetId);
          return { animalId: animal.id, patchId, worldTime: this.host.world.now() };
        });
      } finally {
        if (!placed) await this.store.discardLife(reserved.lifeId);
      }
      if (!placed) return { ok: false, reason: 'no_safe_ground' } as const;
      try {
        await this.store.attachAnimal(reserved.lifeId, placed.animalId, placed.patchId, placed.worldTime);
      } catch (error) {
        // Never an owned animal without its life, nor a life without its animal.
        await this.store.discardLife(reserved.lifeId);
        await this.host.exclusive(async () => this.host.world.disown(placed!.animalId));
        throw error;
      }
      await this.checkpoint().catch((e) => console.error('[owned] checkpoint after spawn failed', e));
      return { ok: true, lifeId: reserved.lifeId, ...placed } as const;
    });
  }

  /**
   * Ends each alive life whose animal has died or is missing, and returns the ended ones. Then
   * frees owned animals that no alive life holds.
   */
  reconcile(now: Date = new Date()): Promise<Array<{ lifeId: string; animalId: string | null; cause: string }>> {
    return this.#serial(async () => {
      const ended: Array<{ lifeId: string; animalId: string | null; cause: string }> = [];
      // Lives left alive by an earlier world (founded again since) are lost: their assets may live here.
      for (const life of await this.store.aliveLivesElsewhere()) {
        const asset = await this.store.asset(life.assetId);
        if (await this.store.endLife(life.lifeId, { cause: 'lost', killerAnimalId: null, worldTime: null, cooldownMs: this.cooldownMs(asset?.speciesId ?? ''), now }))
          ended.push({ lifeId: life.lifeId, animalId: life.animalId, cause: 'lost' });
      }
      const alive = await this.store.aliveLives(), held = new Set<string>();
      for (const life of alive) {
        if (life.animalId === null) {
          if (now.getTime() - life.spawnedAt.getTime() < UNSPAWNED_LOST_MS) continue;
        } else {
          const animal = this.host.world.animal(life.animalId);
          if (animal?.alive && animal.assetId === life.assetId) { held.add(animal.id); continue; }
        }
        const animal = life.animalId === null ? undefined : this.host.world.animal(life.animalId);
        const death = animal && !animal.alive ? animal.ownedDeath : undefined;
        const asset = await this.store.asset(life.assetId);
        const cause = death?.cause ?? 'lost';
        if (await this.store.endLife(life.lifeId, { cause, killerAnimalId: death?.killerId ?? null, worldTime: death?.at ?? animal?.departedAt ?? null,
          cooldownMs: this.cooldownMs(asset?.speciesId ?? ''), now })) ended.push({ lifeId: life.lifeId, animalId: life.animalId, cause });
      }
      const orphans = this.host.world.agents.filter((a) => a.alive && a.assetId !== undefined && !held.has(a.id));
      if (orphans.length) await this.host.exclusive(async () => { for (const a of orphans) this.host.world.disown(a.id); });
      await this.store.settleCooldowns(now);
      return ended;
    });
  }
}
