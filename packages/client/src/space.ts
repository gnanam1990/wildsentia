import { worldGrid } from './worldGrid.js';
import { initialPosition, positionInPatch, subPatchOffset, type WorldPosition } from '@vana/shared';
export { patchCentre, subPatchOffset } from '@vana/shared';

/** Recorded server endpoints when available; interpolation is presentation, not physics. */
/** One world hour at the default live speed of 12x: five real minutes. */
export const HOP_DURATION_MS = 300_000;

interface Track {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  startedAt: number;
  heading: number;
  arrivalHeading: number;
  fromAltitude?: number;
  toAltitude?: number;
}

export interface RenderPosition {
  x: number; z: number; heading: number; moving: boolean; altitudeM?: number;
}

/** One elevation contract for rigs, camera, cutaways, dots and screen-space attachments. */
/**
 * Water deeper than an animal stands at the hip is swum, not walked: its body rides with the back
 * at the waterline and the head above. Shallower water is waded on its feet.
 */
export function swimBaseY(groundY: number, surfaceY: number | null, hipM: number): { y: number; swimming: boolean } {
  if (surfaceY === null || surfaceY - groundY <= hipM * 0.9) return { y: groundY, swimming: false };
  return { y: Math.round((surfaceY - hipM) * 1000) / 1000, swimming: true };
}

export function renderBaseY(position: { x: number; z: number; altitudeM?: number }, groundAt: (x: number, z: number) => number): number {
  return groundAt(position.x, position.z) + (position.altitudeM ?? 0);
}

export class PositionTracker {
  readonly #tracks = new Map<string, Track>();
  /** A hop lasts one world hour in real time, so an animal walks the whole hour, never stop-go. */
  #hopMs = HOP_DURATION_MS;

  /** Follows the speed the server reports: a world hour takes 3,600,000 / speed real ms. */
  setWorldSpeed(worldHoursPerRealHour: number): void {
    if (Number.isFinite(worldHoursPerRealHour) && worldHoursPerRealHour > 0) this.#hopMs = 3_600_000 / worldHoursPerRealHour;
  }

  has(id: string): boolean {
    return this.#tracks.has(id);
  }

  /** A recorded joint pose must become the next interpolation origin, never the old endpoint. */
  placeRecorded(id: string, position: RenderPosition, nowMs: number): void {
    this.#tracks.set(id, { fromX: position.x, fromZ: position.z, toX: position.x, toZ: position.z,
      startedAt: nowMs - this.#hopMs, heading: position.heading, arrivalHeading: position.heading,
      ...(position.altitudeM === undefined ? {} : { fromAltitude: position.altitudeM, toAltitude: position.altitudeM }) });
  }

  update(id: string, patchId: number, nowMs: number, position?: WorldPosition, altitudeM?: number): void {
    const existing = this.#tracks.get(id);
    // Never add a client offset to a precise position. Old data retains the legacy fallback.
    const to = positionInPatch(worldGrid(), position, patchId) ? position : initialPosition(worldGrid(), id, patchId);

    if (existing === undefined) {
      // A newly seen animal appears where it is, rather than sliding in from the last patch.
      this.#tracks.set(id, {
        fromX: to.x, fromZ: to.z, toX: to.x, toZ: to.z,
        startedAt: nowMs - this.#hopMs, heading: to.heading, arrivalHeading: to.heading,
        ...(altitudeM === undefined ? {} : { fromAltitude: altitudeM, toAltitude: altitudeM }),
      });
      return;
    }
    // Duplicate broadcasts do not restart an in-progress interpolation.
    if (existing.toX === to.x && existing.toZ === to.z
      && (existing.toAltitude === altitudeM || existing.toAltitude === 0 && altitudeM === undefined)) {
      existing.arrivalHeading = to.heading; return;
    }

    const current = this.positionAt(id, nowMs);
    this.#tracks.set(id, {
      fromX: current.x, fromZ: current.z,
      toX: to.x, toZ: to.z,
      startedAt: nowMs,
      heading: to.x === current.x && to.z === current.z ? current.heading
        : Math.atan2(to.x - current.x, to.z - current.z), arrivalHeading: to.heading,
      ...(current.altitudeM === undefined && altitudeM === undefined ? {}
        : { fromAltitude: current.altitudeM ?? 0, toAltitude: altitudeM ?? 0 }),
    });
  }

  forgetAllExcept(ids: ReadonlySet<string>): void {
    for (const id of [...this.#tracks.keys()]) {
      if (!ids.has(id)) this.#tracks.delete(id);
    }
  }

  positionAt(id: string, nowMs: number): RenderPosition {
    const track = this.#tracks.get(id);
    if (track === undefined) {
      const offset = subPatchOffset(worldGrid(), id);
      return { x: offset.x, z: offset.z, heading: 0, moving: false };
    }

    const raw = (nowMs - track.startedAt) / this.#hopMs;
    const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
    const eased = t * t * (3 - 2 * t);

    const output: RenderPosition = {
      x: track.fromX + (track.toX - track.fromX) * eased,
      z: track.fromZ + (track.toZ - track.fromZ) * eased,
      heading: t >= 1 ? track.arrivalHeading : track.heading,
      moving: (track.fromX !== track.toX || track.fromZ !== track.toZ
        || (track.fromAltitude ?? 0) !== (track.toAltitude ?? 0)) && t > 0 && t < 1,
    };
    if (track.fromAltitude !== undefined || track.toAltitude !== undefined) {
      output.altitudeM = (track.fromAltitude ?? 0) + ((track.toAltitude ?? track.fromAltitude ?? 0)
        - (track.fromAltitude ?? 0)) * eased;
    }
    return output;
  }

  /** Visual slope only for a server-reported, same-x/z vertical checkpoint change; a move between
   * two places both aloft is a canopy dweller crossing to another tree. */
  verticalPhaseAt(id: string, nowMs: number): 'ascending' | 'descending' | 'crossing' | null {
    const track = this.#tracks.get(id);
    if (!track) return null;
    const progress = (nowMs - track.startedAt) / this.#hopMs;
    if (progress <= 0 || progress >= 1) return null;
    const from = track.fromAltitude ?? 0, to = track.toAltitude ?? 0;
    if (track.fromX !== track.toX || track.fromZ !== track.toZ) return from > 0 && to > 0 ? 'crossing' : null;
    return to > from ? 'ascending' : to < from ? 'descending' : null;
  }
}
