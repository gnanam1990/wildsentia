export const GRID_SIZE = 20;
export const PATCH_METRES = 300;

/**
 * The simulation's spatial resolution is the patch: it knows an animal is in a 300 m cell, not
 * where inside it. The client gives each animal a stable offset within its patch and eases
 * between patch centres over the real time a hop takes, so movement reads as walking rather
 * than teleporting. This renders the server's resolution smoothly; it does not invent a
 * position the server never reported.
 */
export const HOP_DURATION_MS = 150_000; // one world hour at 24x real time

export function patchCentre(patchId: number): { x: number; z: number } {
  return {
    x: (patchId % GRID_SIZE) * PATCH_METRES,
    z: Math.floor(patchId / GRID_SIZE) * PATCH_METRES,
  };
}

function hash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function subPatchOffset(agentId: string): { x: number; z: number } {
  const h = hash(agentId);
  const fx = ((h & 0xffff) / 0xffff) - 0.5;
  const fz = (((h >>> 16) & 0xffff) / 0xffff) - 0.5;
  return { x: fx * PATCH_METRES * 0.8, z: fz * PATCH_METRES * 0.8 };
}

interface Track {
  fromPatch: number;
  toPatch: number;
  startedAt: number;
  heading: number;
}

export interface RenderPosition {
  x: number; z: number; heading: number; moving: boolean;
}

export class PositionTracker {
  readonly #tracks = new Map<string, Track>();

  has(id: string): boolean {
    return this.#tracks.has(id);
  }

  update(id: string, patchId: number, nowMs: number): void {
    const existing = this.#tracks.get(id);

    if (existing === undefined) {
      // A newly seen animal appears where it is, rather than sliding in from the last patch.
      this.#tracks.set(id, {
        fromPatch: patchId, toPatch: patchId,
        startedAt: nowMs - HOP_DURATION_MS, heading: 0,
      });
      return;
    }
    if (existing.toPatch === patchId) return;

    const from = patchCentre(existing.toPatch);
    const to = patchCentre(patchId);
    this.#tracks.set(id, {
      fromPatch: existing.toPatch,
      toPatch: patchId,
      startedAt: nowMs,
      heading: Math.atan2(to.x - from.x, to.z - from.z),
    });
  }

  forgetAllExcept(ids: ReadonlySet<string>): void {
    for (const id of [...this.#tracks.keys()]) {
      if (!ids.has(id)) this.#tracks.delete(id);
    }
  }

  positionAt(id: string, nowMs: number): RenderPosition {
    const track = this.#tracks.get(id);
    const offset = subPatchOffset(id);
    if (track === undefined) return { x: offset.x, z: offset.z, heading: 0, moving: false };

    const raw = (nowMs - track.startedAt) / HOP_DURATION_MS;
    const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
    const eased = t * t * (3 - 2 * t);

    const from = patchCentre(track.fromPatch);
    const to = patchCentre(track.toPatch);

    return {
      x: from.x + (to.x - from.x) * eased + offset.x,
      z: from.z + (to.z - from.z) * eased + offset.z,
      heading: track.heading,
      moving: t > 0 && t < 1,
    };
  }
}
