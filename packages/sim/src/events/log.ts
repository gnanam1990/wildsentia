import { createRng, type Rng, type WorldEvent } from '@vana/shared';

export interface EventLogOptions {
  /**
   * How many events to keep in memory. `'all'` is the archive behaviour the unit tests use.
   * A number makes the log a bounded buffer: appends still count, but older events are dropped
   * once they have been taken.
   *
   * A long run emits millions of events. Holding them all is what exhausts the heap, so any
   * process that runs for a long time — the server, the soak runner — must drain or bound this.
   */
  retain?: number | 'all';
}

export class EventLog {
  readonly #events: WorldEvent[] = [];
  readonly #byActor = new Map<string, WorldEvent[]>();
  readonly #rng: Rng;
  readonly #simVersion: string;
  readonly #retain: number | 'all';
  #total = 0;

  constructor(seed: number, simVersion: string, options: EventLogOptions = {}) {
    this.#rng = createRng(seed, 'events');
    this.#simVersion = simVersion;
    this.#retain = options.retain ?? 'all';
  }

  append(event: Omit<WorldEvent, 'id'>): WorldEvent {
    const suffix = Math.floor(this.#rng.next() * 0xffffffff).toString(16).padStart(8, '0');
    const full: WorldEvent = Object.freeze({
      ...event,
      simVersion: this.#simVersion,
      id: `${event.type}_${suffix}`,
    });

    this.#events.push(full);
    this.#total++;

    if (this.#retain === 'all') {
      for (const actor of full.actors) {
        const list = this.#byActor.get(actor);
        if (list) list.push(full);
        else this.#byActor.set(actor, [full]);
      }
    } else if (this.#events.length > this.#retain) {
      this.#events.splice(0, this.#events.length - this.#retain);
    }

    return full;
  }

  /** Every event still held in memory. With a bounded log this is a window, not the history. */
  all(): readonly WorldEvent[] {
    return Object.freeze(this.#events.slice());
  }

  /**
   * Removes and returns everything buffered. This is how a process hands events to durable
   * storage without the buffer growing without limit.
   */
  take(): WorldEvent[] {
    return this.#events.splice(0, this.#events.length);
  }

  /** Only meaningful on an unbounded log; a bounded one cannot answer for history. */
  byActor(id: string): WorldEvent[] {
    if (this.#retain !== 'all') {
      throw new Error('byActor needs the full history; query the event store instead');
    }
    return (this.#byActor.get(id) ?? []).slice();
  }

  tail(n: number): WorldEvent[] {
    return this.#events.slice(-n);
  }

  /** Total appended over the log's life, including events already taken or dropped. */
  size(): number {
    return this.#total;
  }

  retainedCount(): number {
    return this.#events.length;
  }
}
