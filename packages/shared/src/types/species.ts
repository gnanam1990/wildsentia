import type { HabitatType } from './patch.js';
import type { LifeStage, SkillId } from './agent.js';

export type Archetype =
  | 'apex_predator' | 'pack_predator' | 'herd_grazer'
  | 'mega_herbivore' | 'omnivore_rooter' | 'arboreal_troop' | 'scavenger_flyer';

export type TrophicRole =
  | 'apex_predator' | 'mesopredator' | 'grazer' | 'browser' | 'omnivore' | 'scavenger';

export interface SpeciesConfig {
  id: string;
  displayName: string;
  archetype: Archetype;
  trophicRole: TrophicRole[];
  body: { adultMassKg: number; shoulderHeightM: number };
  locomotion: {
    walkMs: number;
    trotMs: number;
    sprintMs: number;
    sprintStaminaS: number;
    terrainCost: Record<HabitatType, number>;
  };
  senses: { sightRangeM: number; hearingRangeM: number; smellRangeM: number };
  escape: { detectionDistanceM: number; flightInitiationM: number; evasiveness: number };
  diet: {
    eats: Array<{ target: 'grass' | 'browse' | 'meat'; preference: number }>;
    dailyIntakeKg: number;
    /** sim_0.35.0: largest meal beyond the day's need, as a fraction of body mass (meat eaters). */
    gutCapacityBodyFraction?: number;
    waterNeedLPerDay: number;
    canScavenge: boolean;
    /** 0-1 resistance to the pathogens a carcass carries. Vultures are near 1; jackals are not. */
    carrionTolerance: number;
  };
  hunting?: {
    preferredPrey: string[];
    /** How well this predator hides while approaching, before terrain is considered. */
    stalkConcealment: number;
    commitDistanceM: number;
    /** Success against an unaware, healthy adult in the open, before every modifier. */
    baseSuccess: number;
    staminaCostPerChase: number;
    /**
     * sim_0.35.0: hunger below which a predator does not start a hunt. Calibrated to field kill
     * intervals: with its stomach digested, a tiger fasts about two days before hunting again.
     */
    huntFromHunger?: number;
    /**
     * sim_0.36.0: field prey selection as a multiplier on how often a kind of prey is chosen
     * (Jacobs' index D as the selection ratio (1 + D) / (1 - D); 1 where not significant).
     */
    preyPreference?: Record<string, number>;
    /**
     * sim_0.36.0: packmates within this distance of a hunter committing to a hunt join it,
     * relay the chase and feed at the kill (dholes hunt as a pack).
     */
    packHuntRadiusM?: number;
    /** sim_0.36.0: adult mass range [min, max] kg of the prey species a pack hunting together goes for. */
    packPreyKg?: [min: number, max: number];
    /**
     * sim_0.36.0: seconds from a killing bite to the prey's death, by prey mass: a piecewise-
     * linear table of [preyKg, seconds] (held at the ends). A pack divides it among its hunters
     * relative to `subdueReferenceHunters`. Omitted: the prey dies at contact (legacy).
     */
    subdueSeconds?: Array<[preyKg: number, seconds: number]>;
    subdueReferenceHunters?: number;
    /**
     * sim_0.36.0: chance a seized prey as heavy as its hunters (together) breaks free during the
     * hold, scaled down in proportion for lighter prey (Fernández Moya et al. 2021: prey that
     * defended themselves escaped in 10-23.6% of filmed attacks).
     */
    subdueBreakFree?: number;
  };
  social: {
    structure: 'solitary' | 'pair' | 'herd' | 'troop' | 'pack' | 'family';
    groupSize: [min: number, max: number];
    alarmSharing: boolean;
    /** sim_0.34.0: other species whose alarm calls this one takes up when standing with them. */
    heedsAlarmOf?: string[];
    /** Source-informed food-carrying policy; capacities/rates are model parameters, not field calibration. */
    cooperativeCare?: { donorFromDays: number; recipientFromDays: number; capacityBodyFraction: number;
      collectionBodyFractionPerHour: number; deliveryBodyFractionPerHour: number; retentionHours: number;
      moistureLPerKg: number };
    /**
     * Ranges held against others of the same sex. An adult inside an older rival's range is a
     * floater: it does not breed, and it dies or is driven out far more often.
     */
    territory?: {
      femaleKm2: number;
      maleKm2: number;
      floaterMortalityPerDay: number;
    };
  };
  /**
   * sim_0.33.0: rare arrival onto a closed island by swimming or crossing, for species that
   * really do (see docs/2026-10-05-multi-year-ecology.md). Considered once per world day, only
   * while no more than `whenLivingAtMost` of the species live on the island, at most once per
   * `minDaysBetween`, and then with `dailyProbability` from a seed-derived draw. The arriving
   * animal's body is recorded as imported in the nutrient ledger. Ignored on the mainland.
   */
  islandArrival?: {
    whenLivingAtMost: number;
    dailyProbability: number;
    minDaysBetween: number;
  };
  /**
   * Innate floors for the skills this species uses (spec §8). A skill absent here is one the
   * species never uses; it reads as neutral. `learnRateFromParent` is the fraction of the gap
   * to its parent a young animal closes each time it watches her use a skill successfully.
   */
  learning?: {
    innate: Partial<Record<SkillId, number>>;
    learnRateFromParent: number;
  };
  lifecycle: {
    maxAgeDays: number;
    baselineMortalityPerDay: number;
    stages: Array<{
      name: LifeStage;
      startDays: number;
      /** Fraction of adult mass at the start of this stage. */
      sizeFactor: number;
      dependent: boolean;
      mortalityPerDay: number;
    }>;
    sexualMaturityDays: number;
    gestationDays: number;
    litterSize: [min: number, max: number];
    interBirthIntervalDays: number;
    /** Days between one oestrus and the next. A failed courtship waits this long to try again. */
    oestrusCycleDays: number;
    weanDays: number;
    /** Earliest ground-following age. Omitted: conservative weaning-age fallback, not a biological claim. */
    followFromDays?: number;
    /**
     * sim_0.36.0: earliest age a dependent walks to its parent's care point within its senses,
     * before it can follow her on the move: a litter gathering to suckle or to be fed at the nest
     * or den. Omitted: the species' young do not gather (follow rules alone apply).
     */
    gatherFromDays?: number;
    /** Earliest independent plant foraging before weaning; omitted keeps the old weaning gate. */
    forageFromDays?: number;
    /** Earliest independent route to surface water; omitted retains the previous forage/wean gate. */
    drinkFromDays?: number;
    /** Earliest parent-opened finite carcass meal while dependent; omitted retains the weaning gate. */
    meatFromDays?: number;
    /** Source-informed scheduled nursing policy; not milk chemistry or exact field calibration. */
    nursing?: { startHour: number; windowHours: number; dailyContactSeconds: number; locomotionFromDays: number };
    dispersalDays: number;
  };
}
