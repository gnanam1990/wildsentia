import { createRng, type Rng, type WorldEvent } from '@vana/shared';

export class EventLog {
  readonly #events: WorldEvent[] = [];
  readonly #byActor = new Map<string, WorldEvent[]>();
  readonly #rng: Rng;
  readonly #simVersion: string;

  constructor(seed: number, simVersion: string) {
    this.#rng = createRng(seed, 'events');
    this.#simVersion = simVersion;
  }

  append(event: Omit<WorldEvent, 'id'>): WorldEvent {
    const suffix = Math.floor(this.#rng.next() * 0xffffffff).toString(16).padStart(8, '0');
    const full: WorldEvent = Object.freeze({
      ...event,
      simVersion: this.#simVersion,
      id: `${event.type}_${suffix}`,
    });
    this.#events.push(full);
    for (const actor of full.actors) {
      const list = this.#byActor.get(actor);
      if (list) list.push(full);
      else this.#byActor.set(actor, [full]);
    }
    return full;
  }

  all(): readonly WorldEvent[] {
    return Object.freeze(this.#events.slice());
  }

  byActor(id: string): WorldEvent[] {
    return (this.#byActor.get(id) ?? []).slice();
  }

  tail(n: number): WorldEvent[] {
    return this.#events.slice(-n);
  }

  size(): number {
    return this.#events.length;
  }
}
