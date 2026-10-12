import type { Rule } from './terms.js';

/**
 * Watches the rules of one attempt (docs/2026-10-09-challenges-design.md §13). Checked once a
 * second from what the live layer shows, and on every command; the first rule broken fails the
 * attempt. Being apart from the herd is allowed for a short while (a chase, a detour to water).
 */
export const HERD_GRACE_MS = 60_000;

export interface RuleView {
  position: { x: number; z: number };
  gait: string;
  moving: boolean;
  /** Distance to the nearest live animal of the same species, or null if none is near. */
  nearestKinM: number | null;
  /** True if the animal moved at sprint speed at any moment since the last check (a charge may start and end between two). */
  sprinted?: boolean;
}

export class RuleWatch {
  #apartSince: number | null = null;
  constructor(readonly rules: readonly Rule[]) {}

  /** The reason of the rule broken now, or null. `now` is in milliseconds. */
  check(view: RuleView, now: number): string | null {
    for (const rule of this.rules) {
      switch (rule.type) {
        case 'zone':
          if (Math.hypot(view.position.x - rule.x, view.position.z - rule.z) > rule.radiusM) return 'rule_zone';
          break;
        case 'noRun':
          if ((view.moving && view.gait === 'run') || view.sprinted) return 'rule_no_run';
          break;
        case 'herd':
          if (view.nearestKinM === null || view.nearestKinM > rule.maxDistanceM) {
            this.#apartSince ??= now;
            if (now - this.#apartSince > HERD_GRACE_MS) return 'rule_herd';
          } else this.#apartSince = null;
          break;
      }
    }
    return null;
  }

  /** A command that breaks a rule the moment it is given (asking to run under "never run"). */
  commandBreaks(command: string, args: Record<string, unknown>): string | null {
    if (command === 'move' && args.gait === 'run' && this.rules.some((r) => r.type === 'noRun')) return 'rule_no_run';
    return null;
  }

  /** The herd distance rule, if any: the engine looks for kin within it. */
  herdDistance(): number | null {
    const herd = this.rules.find((r) => r.type === 'herd');
    return herd && herd.type === 'herd' ? herd.maxDistanceM : null;
  }
}
