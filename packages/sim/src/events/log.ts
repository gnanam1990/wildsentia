import { ISLAND_GRID, positionInPatch, type WorldEvent, type WorldGrid } from '@vana/shared';

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
  /** The lattice event positions are checked against. A world passes its own; tests default to the island. */
  grid?: WorldGrid;
}

export class EventLog {
  readonly #events: WorldEvent[] = [];
  readonly #byActor = new Map<string, WorldEvent[]>();
  readonly #namespace: string;
  #sequence = 0;
  readonly #simVersion: string;
  readonly #retain: number | 'all';
  readonly grid: WorldGrid;
  #total = 0;

  constructor(seed: number, simVersion: string, options: EventLogOptions = {}) {
    this.#namespace = (seed >>> 0).toString(16).padStart(8, '0');
    this.#simVersion = simVersion;
    this.#retain = options.retain ?? 'all';
    this.grid = options.grid ?? ISLAND_GRID;
  }

  append(event: Omit<WorldEvent, 'id'>): WorldEvent {
    if (event.position !== undefined && !positionInPatch(this.grid, event.position, event.patchId)) {
      throw new Error('event position must be finite and inside its recorded patch');
    }
    if (!Number.isSafeInteger(this.#sequence + 1)) throw new Error('event sequence exhausted');
    // Longer than legacy eight-hex RNG IDs, so old snapshots can migrate without collisions.
    const suffix = this.#namespace + (this.#sequence++).toString(16).padStart(16, '0');
    const full: WorldEvent = Object.freeze({
      ...event,
      ...(event.position === undefined ? {} : { position: Object.freeze({ ...event.position }) }),
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
    } else if (this.#events.length >= this.#retain * 2) {
      // Trimmed in a block once twice the window is held: shifting the whole buffer on every
      // append past the limit was an eighth of a Congo hour. Readers see only the window.
      this.#events.splice(0, this.#events.length - this.#retain);
    }

    return full;
  }

  /** Every event still held in memory. With a bounded log this is a window, not the history. */
  all(): readonly WorldEvent[] {
    return Object.freeze(this.#window());
  }

  /**
   * Removes and returns everything buffered. This is how a process hands events to durable
   * storage without the buffer growing without limit.
   */
  take(): WorldEvent[] {
    this.#byActor.clear();
    const held = this.#window();
    this.#events.length = 0;
    return held;
  }

  exportSequence(): number { return this.#sequence; }

  restoreSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid event sequence');
    this.#sequence = sequence;
  }

  /** Only meaningful on an unbounded log; a bounded one cannot answer for history. */
  byActor(id: string): WorldEvent[] {
    if (this.#retain !== 'all') {
      throw new Error('byActor needs the full history; query the event store instead');
    }
    return (this.#byActor.get(id) ?? []).slice();
  }

  tail(n: number): WorldEvent[] {
    return this.#window().slice(-n);
  }

  /** The retained events: all of them, or the newest `retain` of a bounded log. */
  #window(): WorldEvent[] {
    return this.#retain === 'all' || this.#events.length <= this.#retain ? this.#events.slice() : this.#events.slice(-this.#retain);
  }

  /** Total appended over the log's life, including events already taken or dropped. */
  size(): number {
    return this.#total;
  }

  retainedCount(): number {
    return this.#retain === 'all' ? this.#events.length : Math.min(this.#events.length, this.#retain);
  }
}
