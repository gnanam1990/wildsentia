import { HABITAT_ANALOGUE, type CongoHabitat, type HabitatType, type IslandHabitat } from './patch.js';
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
  body: {
    /** Mean adult mass; growth, needs and size ratios are measured against it. */
    adultMassKg: number;
    shoulderHeightM: number;
    /**
     * sim_0.37.0: adult mass by sex where the sexes differ markedly (leopard males 50-77 kg,
     * females 29-34 kg). Founders start at, and young grow toward, their own sex's mass.
     */
    massBySexKg?: { female: number; male: number };
  };
  locomotion: {
    walkMs: number;
    trotMs: number;
    sprintMs: number;
    sprintStaminaS: number;
    /** Island habitats are required; a Congo habitat left out costs as its analogue (`terrainCostFor`). */
    terrainCost: Record<IslandHabitat, number> & Partial<Record<CongoHabitat, number>>;
    /**
     * sim_0.37.0: climbs its patch's tree to escape a ground predator in the same patch (langur,
     * giant squirrel, leopard). Omitted: a ground animal.
     */
    climbsTrees?: boolean;
  };
  senses: { sightRangeM: number; hearingRangeM: number; smellRangeM: number };
  escape: {
    detectionDistanceM: number; flightInitiationM: number; evasiveness: number;
    /**
     * sim_0.37.0: predators this species keeps away from as prey keep away from what hunts them,
     * though they do not hunt it (leopards avoid tigers: Odden et al. 2010; Harihar et al. 2011).
     */
    avoids?: string[];
  };
  diet: {
    eats: Array<{
      /** sim_0.37.0 `roots`: the finite rooting and mast food of a patch (wild boar). */
      target: 'grass' | 'browse' | 'meat' | 'roots';
      preference: number;
      /**
       * sim_0.37.0: share of a day's food need one kilogram of this food meets (default 1). Wild
       * boar are monogastric and digest fibrous green forage poorly: grass keeps them alive but
       * does not replace roots, tubers, fruit and mast.
       */
      foodValue?: number;
    }>;
    dailyIntakeKg: number;
    /**
     * sim_0.37.0: the most food (kg as eaten) the gut can process in a day. Where some food is
     * worth less than a kilogram of need (foodValue), this is what stops an animal making up poor
     * food by eating more of it (wild boar on fibrous grass). Omitted: no daily limit.
     */
    maxDailyIntakeKg?: number;
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
    /**
     * sim_0.37.0: hauls a kill into its patch's tree where there is one, out of reach of ground
     * scavengers and other predators (leopards: Balme et al. 2017).
     */
    cachesKills?: boolean;
    /**
     * sim_0.37.0: the heaviest individual prey (kg) this hunter goes for, by the prey's own mass,
     * so a leopard takes sambar fawns and wild pig piglets but not an adult sambar stag.
     */
    maxPreyKg?: number;
    /**
     * sim_0.37.0: the prey mass range (kg) this hunter prefers within a kind of prey (Hayward et al.
     * 2006: leopards prefer prey of 10-40 kg): where a kind offers individuals in it, the hunter
     * picks among those, so it takes the piglet before the sow.
     */
    preferredPreyKg?: [min: number, max: number];
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
   *
   * sim_0.37.0: the leopard's crossing is a modelling assumption, not a field fact. Leopards swim,
   * but no sea crossing to an island is documented; the owner chose rare arrivals so a lone leopard
   * is eventually joined. Its rate (a daily chance of 1 in 1,095 while at most one leopard lives, and
   * never twice within three years) is about a sixth of the tiger's: at most three arrivals a decade.
   */
  islandArrival?: {
    whenLivingAtMost: number;
    dailyProbability: number;
    minDaysBetween: number;
    /**
     * sim_0.37.0: when every living animal of the species is of one sex, the arrival is of the
     * other (a modelling choice, so a lone survivor can be joined by a mate). Otherwise either sex,
     * from the arrival's own draw.
     */
    preferMissingSex?: boolean;
  };
  /**
   * sim_0.37.0 daily activity cycle: relative activity for each hour of the day (index 0 is
   * 00:00-01:00), 1 at the species' peak, from camera-trap and telemetry activity curves (sources in
   * docs/2026-10-05-multi-year-ecology.md). An animal that is not starving starts hunts and ranges
   * in proportion to it and otherwise rests. Omitted: active at every hour, as before.
   */
  activity?: {
    hourly: number[];
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
    /**
     * sim_0.37.0: a dependent younger than this clings to its mother and is carried wherever she
     * walks or runs while it is in contact with her (grey langur infants: 100% contact in the first
     * week, following by the fourth; Dolhinow & Murphy 1982). It does not flee on its own.
     */
    carriedUntilDays?: number;
    /** Earliest independent plant foraging before weaning; omitted keeps the old weaning gate. */
    forageFromDays?: number;
    /** Earliest independent route to surface water; omitted retains the previous forage/wean gate. */
    drinkFromDays?: number;
    /** Earliest parent-opened finite carcass meal while dependent; omitted retains the weaning gate. */
    meatFromDays?: number;
    /** Source-informed scheduled nursing policy; not milk chemistry or exact field calibration. */
    nursing?: { startHour: number; windowHours: number; dailyContactSeconds: number; locomotionFromDays: number };
    /**
     * sim_0.37.0: a mother whose young cannot yet follow her stays at the den for this many days
     * after the birth, and is fed there by the pack (dholes: Fox 1984; Johnsingh 1982). She still
     * drinks and still hunts once her hunger is desperate. Requires cooperative care.
     */
    denStayDays?: number;
    /**
     * sim_0.37.0: reproduction that tracks food. Body condition is a running mean, over
     * `conditionDays`, of the share of daily need met by the natural diet (rooting and mast food).
     * A female conceives at full chance at `fullBreedingCondition` or above and not at all below
     * `minBreedingCondition`; litter size moves from the configured minimum to the maximum across
     * the same range (wild boar: Bieber & Ruf 2005; Servanty et al. 2009). Needs a roots diet and
     * a daily gut limit.
     */
    condition?: { conditionDays: number; minBreedingCondition: number; fullBreedingCondition: number };
    dispersalDays: number;
  };
}

/** What crossing a habitat costs this species: its own figure, or its analogue's for a Congo habitat it does not name. */
export function terrainCostFor(cfg: Pick<SpeciesConfig, 'locomotion'>, habitat: HabitatType): number {
  const own = (cfg.locomotion.terrainCost as Partial<Record<HabitatType, number>>)[habitat];
  return own ?? cfg.locomotion.terrainCost[HABITAT_ANALOGUE[habitat as CongoHabitat] ?? (habitat as IslandHabitat)];
}
