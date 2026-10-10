import { positionInPatch, type WorldPosition } from '@vana/shared';

export interface Drives {
  hunger: number; thirst: number; fatigue: number; fear: number;
}

export interface AnimalState {
  id: string;
  speciesId: string;
  patchId: number;
  position?: WorldPosition | undefined;
  altitudeM?: number | undefined;
  locomotionMode?: 'ground' | 'flight' | 'climb' | undefined;
  state: string;
  currentGoal: string;
  /** Only an active authoritative episode is observer-visible; incubation is not displayed. */
  illnessStatus?: 'symptomatic' | undefined;
  /** Server-reported modelled contact injury; no client-derived diagnosis or severity. */
  woundStatus?: 'open' | 'infected' | undefined;
  drives: Drives;
  lifeStage?: string | undefined;
  sex?: string | undefined;
  sizeRatio?: number | undefined;
  coatVariant?: number | undefined;
  decayStage?: number | undefined;
  dependentOn?: string | null | undefined;
  groupId?: string | null | undefined;
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
  /** How many world hours pass per real hour. Undefined when the server did not say. */
  worldHoursPerRealHour?: number | undefined;
}

type Listener = () => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * Holds what the server said, and only what the server said. The client never fills a gap with
 * a guess — a missing field stays missing so the HUD can say so instead of inventing a number.
 */
/** How long a server error stays on screen. */
export const ERROR_NOTICE_MS = 10_000;

export class WorldStore {
  world: WorldState | null = null;
  readonly animals = new Map<string, AnimalState>();
  readonly viewerCounts = new Map<string, number>();
  lastError: string | null = null;
  /** When the server last reported an error (Date.now()); see errorNotice. */
  lastErrorAt = 0;

  readonly #listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Publish a fully prepared checkpoint once; subscribers never see a half-updated pair. */
  replaceCheckpoint(world: WorldState, animals: readonly AnimalState[]): void {
    this.world = world;
    this.animals.clear();
    for (const animal of animals) this.animals.set(animal.id, animal);
    for (const fn of this.#listeners) fn();
  }

  /** The server's last error while it is recent; a passing protocol error should not stay on screen. */
  errorNotice(now = Date.now()): string | null {
    return this.lastError !== null && now - this.lastErrorAt < ERROR_NOTICE_MS ? this.lastError : null;
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
          worldHoursPerRealHour: typeof message.worldHoursPerRealHour === 'number'
            ? message.worldHoursPerRealHour : undefined,
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
            position: positionInPatch(raw.position, Number(raw.patchId)) ? { ...raw.position } : undefined,
            altitudeM: typeof raw.altitudeM === 'number' && Number.isFinite(raw.altitudeM)
              && raw.altitudeM >= 0 && raw.altitudeM <= 2_000 ? raw.altitudeM : undefined,
            locomotionMode: raw.locomotionMode === 'flight' || raw.locomotionMode === 'climb'
              || raw.locomotionMode === 'ground' ? raw.locomotionMode : undefined,
            state: String(raw.state ?? 'resting'),
            currentGoal: String(raw.currentGoal ?? 'wander'),
            illnessStatus: raw.illnessStatus === 'symptomatic' ? 'symptomatic' : undefined,
            woundStatus: raw.woundStatus === 'open' || raw.woundStatus === 'infected'
              ? raw.woundStatus : undefined,
            drives: isRecord(raw.drives)
              ? (raw.drives as unknown as Drives)
              : { hunger: 0, thirst: 0, fatigue: 0, fear: 0 },
            lifeStage: typeof raw.lifeStage === 'string' ? raw.lifeStage : undefined,
            sex: typeof raw.sex === 'string' ? raw.sex : undefined,
            sizeRatio: typeof raw.sizeRatio === 'number' && Number.isFinite(raw.sizeRatio) ? raw.sizeRatio : undefined,
            coatVariant: typeof raw.coatVariant === 'number' && Number.isFinite(raw.coatVariant) ? raw.coatVariant : undefined,
            decayStage: typeof raw.decayStage === 'number' && Number.isInteger(raw.decayStage)
              && raw.decayStage >= 1 && raw.decayStage <= 5 ? raw.decayStage : undefined,
            dependentOn: typeof raw.dependentOn === 'string' ? raw.dependentOn : null,
            groupId: typeof raw.groupId === 'string' ? raw.groupId : null,
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
        this.lastErrorAt = Date.now();
        break;
      }
      default:
        return;
    }

    for (const fn of this.#listeners) fn();
  }
}
