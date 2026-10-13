import { daylightAt, perceive, windAt } from './perception.js';

interface ActiveBounty { bountyId: string; targetAnimalId: string; amountAtomic: bigint; decimals: number; deadlineWorldTime: number | null }
interface DiscoveryStore {
  active(): Promise<ActiveBounty[]>;
  recordEntrant(bountyId: string, agentId: string, animalId: string, worldTime: number): Promise<boolean>;
}
export interface Sensed { id: string; x: number; z: number; moving: boolean; running: boolean }

/**
 * How an animal is moving now: a steered one by its avatar (the sim's state stays 'resting' while
 * an agent steers it), one in a live chase by its runner, else by the sim's last state.
 */
export function motionOf(animal: { state: string }, runner: { mode: string } | null | undefined,
  avatar: { moving: boolean; gait: string } | null | undefined): { moving: boolean; running: boolean } {
  if (avatar) return { moving: avatar.moving, running: avatar.moving && avatar.gait === 'run' };
  if (runner && runner.mode !== 'idle') return { moving: true, running: true };
  return { moving: ['travelling', 'fleeing', 'chasing', 'stalking'].includes(animal.state),
    running: animal.state === 'fleeing' || animal.state === 'chasing' };
}
export interface BountyFlag { bountyId: string; amountAtomic: string; decimals: number; timeLeftWorldSeconds: number }

/**
 * Congo 1D (spec §6): what each agent's animal perceives, and the bounty it learns of that way.
 * Only sensed animals are listed; a sensed bounty target carries its bounty; once out of sense,
 * only its last-seen position and time remain. The first sighting enters the agent.
 */
export class BountyDiscovery {
  #byTarget = new Map<string, ActiveBounty>();
  #lastSeen = new Map<string, Map<string, { x: number; z: number; worldTime: number }>>();
  #entered = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DiscoveryStore, private readonly worldId: () => string) {}

  /** Reloads the active bounties (a timer calls this every few seconds). */
  async refresh(): Promise<void> {
    // Held bounties are not on offer: no agent is told of them.
    const active = (await this.store.active()).filter((b) => (b as { status?: string }).status === undefined || (b as { status?: string }).status === 'active');
    this.#byTarget = new Map(active.map((b) => [b.targetAnimalId, b]));
    const live = new Set(active.map((b) => b.bountyId));
    for (const seen of this.#lastSeen.values()) for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
  }

  /** Resolves when every entrant write queued so far has run. */
  idle(): Promise<void> { return this.#queue.then(() => undefined); }

  #flag(b: ActiveBounty, worldTime: number): BountyFlag {
    return { bountyId: b.bountyId, amountAtomic: b.amountAtomic.toString(), decimals: b.decimals,
      timeLeftWorldSeconds: Math.max(0, (b.deadlineWorldTime ?? worldTime) - worldTime) };
  }

  view(agentId: string, observer: { animalId: string; speciesId: string; x: number; z: number }, nearby: readonly Sensed[],
    c: { canopyAt(x: number, z: number): number; worldTime: number }): { nearby: Array<Sensed & { sense: string; bounty?: BountyFlag }>; lastSeen: Array<{ bountyId: string; x: number; z: number; worldTime: number } & Omit<BountyFlag, 'bountyId'>> } {
    const conditions = { daylight: daylightAt(c.worldTime), windHeading: windAt(this.worldId(), c.worldTime) };
    const seen = this.#lastSeen.get(agentId) ?? new Map<string, { x: number; z: number; worldTime: number }>();
    const listed: Array<Sensed & { sense: string; bounty?: BountyFlag }> = [];
    for (const a of nearby) {
      const sense = perceive(observer, a, { ...conditions, canopy: c.canopyAt(a.x, a.z) });
      if (!sense) continue;
      const b = this.#byTarget.get(a.id);
      if (b && a.id !== observer.animalId) {
        seen.set(b.bountyId, { x: a.x, z: a.z, worldTime: c.worldTime });
        const key = `${b.bountyId}:${agentId}`;
        if (!this.#entered.has(key)) {
          this.#entered.add(key);
          this.#queue = this.#queue.then(() => this.store.recordEntrant(b.bountyId, agentId, observer.animalId, c.worldTime))
            .catch(() => { this.#entered.delete(key); }); // tried again at the next sighting
        }
        listed.push({ ...a, sense, bounty: this.#flag(b, c.worldTime) });
      } else listed.push({ ...a, sense });
    }
    if (seen.size) this.#lastSeen.set(agentId, seen);
    // A sensed bounty target leads the list, so however crowded the forest it is never cut off.
    listed.sort((a, b) => Number(!!b.bounty) - Number(!!a.bounty));
    const sensedNow = new Set(listed.filter((a) => a.bounty).map((a) => a.bounty!.bountyId));
    const lastSeen = [...seen.entries()].filter(([id]) => !sensedNow.has(id)).flatMap(([id, at]) => {
      const b = [...this.#byTarget.values()].find((x) => x.bountyId === id);
      if (!b) return [];
      const { bountyId: _id, ...flag } = this.#flag(b, c.worldTime);
      return [{ bountyId: id, ...at, ...flag }];
    });
    return { nearby: listed, lastSeen };
  }
}
