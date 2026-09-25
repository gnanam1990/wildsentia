import { isCommunityState, type CommunityState, type LiveEncounterFrame, type MicroEcologyState } from '@vana/shared';
import { WorldStore, type AnimalState, type WorldState } from './protocol.js';
import { isLiveEncounterFrame } from './liveEncounters.js';
import type { PatchView } from './terrain.js';

export interface SceneEnvironment { patches: PatchView[]; carcasses: AnimalState[]; microEcology?: MicroEcologyState; community?: CommunityState | null }
export interface SceneUpdate {
  checkpointId: string;
  world: WorldState;
  animals: AnimalState[];
  environment: SceneEnvironment;
  frame: LiveEncounterFrame | null;
  frameReceivedAt: number;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const integer = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
function animals(value: unknown): AnimalState[] | null {
  if (!Array.isArray(value) || value.length > 100_000) return null;
  const ids = new Set<string>();
  for (const a of value) {
    if (!record(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id)
      || typeof a.speciesId !== 'string' || !a.speciesId || !integer(a.patchId)
      || typeof a.state !== 'string' || typeof a.currentGoal !== 'string' || !record(a.drives)) return null;
    if (!['hunger', 'thirst', 'fear', 'fatigue'].every((key) => nonnegative((a.drives as Record<string, unknown>)[key]))) return null;
    ids.add(a.id);
  }
  const parsed = new WorldStore(); parsed.apply({ type: 'animals', animals: value });
  return [...parsed.animals.values()];
}
function environment(value: unknown): SceneEnvironment | null {
  if (!record(value) || !Array.isArray(value.patches) || value.patches.length === 0 || value.patches.length > 10_000) return null;
  const ids = new Set<number>();
  const islandSeed = record(value.patches[0]) ? value.patches[0].islandSeed : undefined;
  if (islandSeed !== undefined && (!Number.isSafeInteger(islandSeed) || value.patches.length !== 400)) return null;
  for (const p of value.patches) {
    if (!record(p) || !integer(p.id) || ids.has(p.id) || !integer(p.x) || !integer(p.y)
      || typeof p.habitat !== 'string' || ![p.grass, p.browse, p.water].every(nonnegative)
      || !nonnegative(p.elevation) || p.elevation > 1 || !nonnegative(p.canopyCover) || p.canopyCover > 1) return null;
    ids.add(p.id);
    if (p.islandSeed !== islandSeed || (islandSeed !== undefined && (!['land', 'coast', 'ocean'].includes(String(p.surface)) || p.id >= 400))
      || (islandSeed === undefined && p.surface !== undefined)) return null;
    if (p.floweringGuild !== undefined && p.floweringGuild !== null) {
      const guild = p.floweringGuild;
      if (!record(guild) || !['shola', 'riparian'].includes(p.habitat as string)
        || p.surface === 'coast' || p.surface === 'ocean'
        || guild.guildId !== 'insect_visited_understorey_v1'
        || ![guild.vegetativeKg, guild.openKg, guild.visitedKg, guild.seedKg].every(nonnegative)
        || !['vegetative', 'flowering', 'maturing', 'seed_bank'].includes(String(guild.stage))
        || guild.nextEligibleAt !== null && !integer(guild.nextEligibleAt)) return null;
    }
  }
  const carcasses = animals(value.carcasses);
  if (!carcasses || carcasses.some((c) => c.state !== 'dead')) return null;
  let microEcology: MicroEcologyState | undefined;
  if (value.microEcology !== undefined) {
    if (!record(value.microEcology) || !finite(value.microEcology.updatedAt)
      || !Array.isArray(value.microEcology.patches) || value.microEcology.patches.length > 10_000) return null;
    const seen = new Set<number>();
    for (const raw of value.microEcology.patches) {
      if (!record(raw) || !integer(raw.patchId) || seen.has(raw.patchId) || ![
        raw.antColonies, raw.fishSchools, raw.antBiomassKg, raw.pollinatorBiomassKg,
        raw.detritivoreBiomassKg, raw.aquaticProducerBiomassKg, raw.fishBiomassKg, raw.decomposerBiomassKg,
      ].every(nonnegative)) return null;
      seen.add(raw.patchId);
    }
    microEcology = value.microEcology as unknown as MicroEcologyState;
  }
  if (value.community !== undefined && value.community !== null && (!isCommunityState(value.community)
    || !ids.has(value.community.patchId))) return null;
  return { patches: value.patches as PatchView[], carcasses, ...(microEcology ? { microEcology } : {}),
    ...(value.community === undefined ? {} : { community: value.community as CommunityState | null }) };
}

/** One in-flight preparation and one latest update. Never queue whole scenes without a bound. */
export class SceneUpdates<Prepared> {
  #received: SceneUpdate | null = null;
  #pending: SceneUpdate | null = null;
  #committedId: string | null = null;
  #generation = 0;
  #running = false;
  constructor(private readonly hooks: {
    prepare(environment: SceneEnvironment): Promise<Prepared>;
    commit(update: SceneUpdate, prepared: Prepared | undefined): void;
    discard(prepared: Prepared): void;
    status(state: 'loading' | 'ready' | 'stale'): void;
  }) {}

  reset(): void {
    this.#generation++; this.#received = null; this.#pending = null; this.#committedId = null;
    this.hooks.status('stale');
  }

  receive(message: unknown, receivedAt: number): boolean {
    if (!record(message) || message.type !== 'scene' || message.protocol !== 1
      || typeof message.checkpointId !== 'string' || !message.checkpointId || !finite(receivedAt)
      || !record(message.world) || !integer(message.world.worldTime) || !integer(message.world.nextEventSequence)
      || !record(message.world.population) || !Object.values(message.world.population).every(integer)
      || !finite(message.world.worldHoursPerRealHour) || message.world.worldHoursPerRealHour <= 0) return false;
    const previous = this.#received?.checkpointId === message.checkpointId ? this.#received : null;
    // Ordered WebSocket messages may repeat a checkpoint, never roll back within a connection.
    if (this.#received && message.world.worldTime < this.#received.world.worldTime) return false;
    const env = message.environment === undefined ? previous?.environment : environment(message.environment);
    const living = animals(message.animals);
    if (!env || !living || (env.community && env.community.updatedAt !== message.world.worldTime)) return false;
    let frame: LiveEncounterFrame | null;
    if (message.frame === undefined) {
      if (!previous) return false;
      frame = previous.frame;
    } else {
      if (message.frame !== null && (!isLiveEncounterFrame(message.frame) || message.frame.endWorldTime !== message.world.worldTime)) return false;
      frame = message.frame as LiveEncounterFrame | null;
    }
    const parsed = new WorldStore(); parsed.apply({ ...message.world, type: 'world' });
    this.#pending = this.#received = { checkpointId: message.checkpointId, world: parsed.world!, animals: living,
      environment: env, frame, frameReceivedAt: message.frame === undefined ? previous!.frameReceivedAt : receivedAt };
    void this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#pending) {
        let update = this.#pending; this.#pending = null;
        const generation = this.#generation;
        let prepared: Prepared | undefined;
        try {
          if (update.checkpointId !== this.#committedId) {
            this.hooks.status('loading'); prepared = await this.hooks.prepare(update.environment);
          }
          const latest = this.#pending as SceneUpdate | null;
          if (generation !== this.#generation || (latest && latest.checkpointId !== update.checkpointId)) {
            if (prepared !== undefined) this.hooks.discard(prepared);
            continue;
          }
          if (latest) { update = latest; this.#pending = null; }
          this.hooks.commit(update, prepared); this.#committedId = update.checkpointId;
          this.hooks.status('ready');
        } catch {
          if (prepared !== undefined) this.hooks.discard(prepared);
          if (generation === this.#generation) this.hooks.status('stale');
        }
      }
    } finally { this.#running = false; }
  }
}
