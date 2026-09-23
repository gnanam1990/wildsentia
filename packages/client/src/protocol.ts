export interface Drives {
  hunger: number; thirst: number; fatigue: number; fear: number;
}

export interface AnimalState {
  id: string;
  speciesId: string;
  patchId: number;
  state: string;
  currentGoal: string;
  drives: Drives;
  /** Read by the thought bubble. Undefined when the server did not send it. */
  alternativeGoal?: string | null | undefined;
  goalScore?: number | undefined;
  dependent?: boolean | undefined;
}

export interface WorldState {
  worldTime: number;
  formatted: string;
  season: string;
  population: Record<string, number>;
}

type Listener = () => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * Holds what the server said, and only what the server said. The client never fills a gap with
 * a guess — a missing field stays missing so the HUD can say so instead of inventing a number.
 */
export class WorldStore {
  world: WorldState | null = null;
  readonly animals = new Map<string, AnimalState>();
  readonly viewerCounts = new Map<string, number>();
  lastError: string | null = null;

  readonly #listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  apply(message: unknown): void {
    if (!isRecord(message)) return;

    switch (message.type) {
      case 'world': {
        if (typeof message.worldTime !== 'number') return;
        this.world = {
          worldTime: message.worldTime,
          formatted: String(message.formatted ?? ''),
          season: String(message.season ?? ''),
          population: isRecord(message.population)
            ? (message.population as Record<string, number>)
            : {},
        };
        break;
      }
      case 'animals': {
        if (!Array.isArray(message.animals)) return;
        this.animals.clear();
        for (const raw of message.animals) {
          if (!isRecord(raw) || typeof raw.id !== 'string') continue;
          this.animals.set(raw.id, {
            id: raw.id,
            speciesId: String(raw.speciesId ?? 'unknown'),
            patchId: Number(raw.patchId ?? 0),
            state: String(raw.state ?? 'resting'),
            currentGoal: String(raw.currentGoal ?? 'wander'),
            drives: isRecord(raw.drives)
              ? (raw.drives as unknown as Drives)
              : { hunger: 0, thirst: 0, fatigue: 0, fear: 0 },
            alternativeGoal: typeof raw.alternativeGoal === 'string' || raw.alternativeGoal === null
              ? raw.alternativeGoal : undefined,
            goalScore: typeof raw.goalScore === 'number' ? raw.goalScore : undefined,
            dependent: typeof raw.dependent === 'boolean' ? raw.dependent : undefined,
          });
        }
        break;
      }
      case 'viewers': {
        if (typeof message.actorId !== 'string') return;
        this.viewerCounts.set(message.actorId, Number(message.count ?? 0));
        break;
      }
      case 'error': {
        this.lastError = String(message.message ?? 'unknown error');
        break;
      }
      default:
        return;
    }

    for (const fn of this.#listeners) fn();
  }
}
