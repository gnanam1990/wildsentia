import type { HabitatType, SpeciesConfig } from '@vana/shared';

/**
 * A species' field guide for agents (docs/2026-10-09-challenges-design.md §13): what the island's
 * own numbers say about how the animal moves, eats, senses, hunts and is hunted. Facts only,
 * taken from the species config the simulation runs on; no persona and no advice beyond them.
 */
export interface FieldGuide {
  id: string; displayName: string; kind: string;
  sizeKg: number; shoulderHeightM: number;
  speedsMs: { walk: number; trot: number; run: number };
  /** How long it can run flat out; stamina refills about three times slower than it drains. */
  runSeconds: number;
  /** Habitats from easiest to hardest to cross (1 = open grassland pace). */
  terrain: Array<{ habitat: HabitatType; cost: number }>;
  climbsTrees: boolean; flies: boolean;
  eats: string[]; scavenges: boolean; waterLitresPerDay: number;
  senses: { sightM: number; hearingM: number; smellM: number };
  /** Prey only: how close a threat is noticed, and how close before it flees. */
  escape: { noticesThreatsAtM: number; fleesAtM: number };
  social: { structure: string; groupSize: [number, number]; warnsOthers: boolean; isHerd: boolean };
  hunts: Array<{ id: string; displayName: string }>;
  /** Hunting only: how often a hunt that reaches its prey kills, and how close it creeps before charging. */
  hunting: { killRate: number; chargesFromM: number; concealment: number } | null;
  huntedBy: Array<{ id: string; displayName: string }>;
  avoids: Array<{ id: string; displayName: string }>;
}

const KINDS: Record<SpeciesConfig['archetype'], string> = {
  apex_predator: 'solitary hunter', pack_predator: 'pack hunter', herd_grazer: 'grazer',
  mega_herbivore: 'large herbivore', omnivore_rooter: 'omnivore', arboreal_troop: 'tree dweller', scavenger_flyer: 'scavenging bird',
};
/** Group structures the herd rule can be set for. */
export const HERD_STRUCTURES = new Set(['herd', 'pack', 'family', 'troop']);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function fieldGuide(cfg: SpeciesConfig, all: readonly SpeciesConfig[]): FieldGuide {
  const name = (id: string) => ({ id, displayName: all.find((s) => s.id === id)?.displayName ?? id });
  const prey = cfg.hunting?.preferredPrey ?? [];
  const l = cfg.locomotion;
  return {
    id: cfg.id, displayName: cfg.displayName, kind: KINDS[cfg.archetype],
    sizeKg: cfg.body.adultMassKg, shoulderHeightM: cfg.body.shoulderHeightM,
    speedsMs: { walk: l.walkMs, trot: l.trotMs, run: l.sprintMs }, runSeconds: l.sprintStaminaS,
    terrain: (Object.entries(l.terrainCost) as Array<[HabitatType, number]>).map(([habitat, cost]) => ({ habitat, cost }))
      .sort((a, b) => a.cost - b.cost),
    climbsTrees: l.climbsTrees === true, flies: cfg.id === 'vulture',
    eats: cfg.diet.eats.slice().sort((a, b) => b.preference - a.preference).map((e) => e.target),
    scavenges: cfg.diet.canScavenge, waterLitresPerDay: cfg.diet.waterNeedLPerDay,
    senses: { sightM: cfg.senses.sightRangeM, hearingM: cfg.senses.hearingRangeM, smellM: cfg.senses.smellRangeM },
    escape: { noticesThreatsAtM: cfg.escape.detectionDistanceM, fleesAtM: cfg.escape.flightInitiationM },
    social: { structure: cfg.social.structure, groupSize: [cfg.social.groupSize[0], cfg.social.groupSize[1]],
      warnsOthers: cfg.social.alarmSharing === true, isHerd: HERD_STRUCTURES.has(cfg.social.structure) },
    hunts: prey.map(name),
    hunting: cfg.hunting && prey.length ? { killRate: round(cfg.hunting.baseSuccess), chargesFromM: cfg.hunting.commitDistanceM,
      concealment: round(cfg.hunting.stalkConcealment) } : null,
    huntedBy: all.filter((s) => s.hunting?.preferredPrey.includes(cfg.id)).map((s) => name(s.id)),
    avoids: (cfg.escape.avoids ?? []).map(name),
  };
}
