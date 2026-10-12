import type { Agent } from '@vana/shared';
import { CARE_FEAR_BLOCK, HUNGER_DESPERATION } from '@vana/sim';

/**
 * sim_0.37.0: what a parent was going through while a dependent of hers died, read hour by hour
 * from simulation state alone (her drives and chosen goal), so the island gate can tell a care
 * failure from an ecological death.
 *
 * Each simulated hour, every animal with a living dependent is sampled once, after the hour is
 * stepped:
 * - starving: hunger at or above HUNGER_DESPERATION (0.8), the model's own starvation threshold,
 *   at which an animal goes where it must for food whatever its tether, fear or young;
 * - threatened: fear at or above CARE_FEAR_BLOCK (0.5), the level at which a parent breaks off care
 *   (availableForCare), or the goal of fleeing. Fear rises only from a detected predator that hunts
 *   it, an alarm from its own kind or a heeded species, or an attack.
 *
 * A dependent's thirst death with its living parent out of reach is ecological, reported and not
 * gated, when either of these held:
 * - famine: the parent was starving in the hour of the death, or in at least ECOLOGICAL_HOURS of
 *   the 48 hours up to and including it;
 * - predator: the parent was threatened in at least ECOLOGICAL_HOURS of those 48 hours.
 * Every other such death is a care failure and fails the gate.
 */
export const CARE_WINDOW_HOURS = 48;
/** A quarter of the window: half a day in two. */
export const ECOLOGICAL_HOURS = 12;

export interface ParentCareSummary {
  /** Hours sampled in the window (fewer than 48 early in a run). */
  hours: number;
  starvingHours: number;
  threatHours: number;
  starvingAtLastSample: boolean;
}

export type EcologicalReason = 'famine' | 'predator';

interface Ring { lastHour: number; starving: boolean[]; threat: boolean[] }

export class ParentCareHistory {
  readonly #rings = new Map<string, Ring>();

  /** Sample every parent of a living dependent once for simulated hour `hour`. */
  sample(agents: readonly Agent[], hour: number): void {
    const parents = new Set<string>();
    for (const a of agents) if (a.alive && a.dependentOn) parents.add(a.dependentOn);
    for (const a of agents) {
      if (!a.alive || !parents.has(a.id)) continue;
      const ring = this.#rings.get(a.id) ?? { lastHour: hour, starving: [], threat: [] };
      ring.lastHour = hour;
      ring.starving.push(a.drives.hunger >= HUNGER_DESPERATION);
      ring.threat.push(a.drives.fear >= CARE_FEAR_BLOCK || a.currentGoal === 'flee');
      if (ring.starving.length > CARE_WINDOW_HOURS) { ring.starving.shift(); ring.threat.shift(); }
      this.#rings.set(a.id, ring);
    }
    // A parent with no dependent left is kept for a window, for deaths reported in the same hour.
    for (const [id, ring] of this.#rings) if (hour - ring.lastHour > CARE_WINDOW_HOURS) this.#rings.delete(id);
  }

  summary(parentId: string): ParentCareSummary | null {
    const ring = this.#rings.get(parentId);
    if (!ring || !ring.starving.length) return null;
    return { hours: ring.starving.length, starvingHours: ring.starving.filter(Boolean).length,
      threatHours: ring.threat.filter(Boolean).length, starvingAtLastSample: ring.starving.at(-1)! };
  }
}

/** Why a thirst death beside a living, out-of-reach parent is ecological, or null: a care failure. */
export function ecologicalReason(summary: ParentCareSummary | null): EcologicalReason | null {
  if (!summary) return null;
  if (summary.starvingAtLastSample || summary.starvingHours >= ECOLOGICAL_HOURS) return 'famine';
  if (summary.threatHours >= ECOLOGICAL_HOURS) return 'predator';
  return null;
}
