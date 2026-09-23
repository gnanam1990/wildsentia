import type { Agent, Rng, SkillId, SkillState, SpeciesConfig } from '@vana/shared';

/** A skill at this confidence leaves the mechanic it feeds exactly as it was tuned. */
export const NEUTRAL_CONFIDENCE = 0.5;

/**
 * How far an animal can get on its own. Practice lifts confidence toward this and no further;
 * past it, an animal only goes as far as a better teacher takes it. Without a ceiling, a grazer
 * that feeds eight hours a day would perfect its foraging within a season, and every lineage
 * would end up alike — which would leave teaching nothing to do.
 */
export const SELF_TAUGHT_CEILING = 0.6;

/**
 * Fraction of the gap to the self-taught ceiling closed by one success. Slow on purpose: an
 * orphan that drinks once a day takes years to work out on its own the water holes its mother
 * would have shown it in a season.
 */
const PRACTICE_RATE = 0.0005;
/** Fraction of the margin above the floor lost each hour of disuse. Slow: about a third a year. */
const DECAY_PER_HOUR = 0.00005;
const ONE_DAY_SECONDS = 86_400;
/** A skill used within this long is in use and does not fade. */
const DISUSE_GRACE_SECONDS = 30 * 86_400;

function floorOf(config: SpeciesConfig, skill: SkillId): number | undefined {
  return config.learning?.innate[skill];
}

/** The confidence an animal has in a skill. A skill its species never uses reads as neutral. */
export function confidenceOf(agent: Agent, config: SpeciesConfig, skill: SkillId): number {
  const floor = floorOf(config, skill);
  if (floor === undefined) return NEUTRAL_CONFIDENCE;
  return agent.skills?.[skill]?.confidence ?? floor;
}

function stateOf(agent: Agent, config: SpeciesConfig, skill: SkillId): SkillState | null {
  const floor = floorOf(config, skill);
  if (floor === undefined) return null;
  agent.skills ??= {};
  return (agent.skills[skill] ??= {
    confidence: floor, successes: 0, failures: 0, lastUsed: 0, taughtBy: null,
  });
}

/**
 * Personal experience. Success lifts confidence toward what an animal can teach itself. A
 * failure is counted but costs nothing: most hunts fail even for the best hunters, and when
 * each miss cost confidence, every predator's technique sank to its floor within a generation.
 * What erodes a skill is disuse (decaySkills).
 */
export function recordOutcome(
  agent: Agent,
  config: SpeciesConfig,
  skill: SkillId,
  success: boolean,
  worldTime: number,
): void {
  const state = stateOf(agent, config, skill);
  if (state === null) return;
  if (success) {
    state.successes++;
    state.confidence += PRACTICE_RATE * Math.max(0, SELF_TAUGHT_CEILING - state.confidence);
  } else {
    state.failures++;
  }
  state.lastUsed = worldTime;
}

/**
 * A young animal watching its parent use a skill well closes part of the gap to her. It never
 * passes her: a mother who is a poor hunter raises poor hunters. Returns true when the pupil
 * crosses a tenth, which is when the world records the lesson.
 */
export function teach(
  pupil: Agent,
  teacher: Agent,
  config: SpeciesConfig,
  skill: SkillId,
  worldTime: number,
): boolean {
  const rate = config.learning?.learnRateFromParent;
  if (rate === undefined) return false;
  const teacherConfidence = confidenceOf(teacher, config, skill);
  const before = confidenceOf(pupil, config, skill);
  if (teacherConfidence <= before) return false;

  // One lesson a day. A grazing mother feeds eight hours a day, and taught on every mouthful a
  // fawn knew all she knew within a fortnight, so an orphan was as capable as one raised.
  const state = stateOf(pupil, config, skill)!;
  if (state.taughtBy === teacher.id && worldTime - state.lastUsed < ONE_DAY_SECONDS) return false;
  state.confidence = Math.min(teacherConfidence, before + rate * (teacherConfidence - before));
  state.taughtBy = teacher.id;
  state.lastUsed = worldTime;
  return Math.floor(state.confidence * 10) > Math.floor(before * 10);
}

/**
 * Knowledge fades with disuse, back toward what the species knows from birth. A skill in use
 * holds: decaying everything all the time pulled every lineage back to the same level within a
 * generation, and teaching then made no lasting difference.
 */
export function decaySkills(agent: Agent, config: SpeciesConfig, hours: number, worldTime: number): void {
  if (agent.skills === undefined) return;
  const keep = Math.exp(-DECAY_PER_HOUR * hours);
  for (const [skill, state] of Object.entries(agent.skills) as Array<[SkillId, SkillState]>) {
    const floor = floorOf(config, skill);
    if (floor === undefined) continue;
    if (worldTime - state.lastUsed < DISUSE_GRACE_SECONDS) continue;
    state.confidence = floor + (state.confidence - floor) * keep;
  }
}

/** Founders and immigrants arrive grown, with a life's experience behind them. */
export function experiencedSkills(
  config: SpeciesConfig,
  rng: Rng,
  worldTime = 0,
): Partial<Record<SkillId, SkillState>> {
  const skills: Partial<Record<SkillId, SkillState>> = {};
  for (const [skill, floor] of Object.entries(config.learning?.innate ?? {}) as Array<[SkillId, number]>) {
    skills[skill] = {
      confidence: Math.min(1, floor + rng.range(0.25, 0.55)),
      successes: 0, failures: 0, lastUsed: worldTime, taughtBy: null,
    };
  }
  return skills;
}

/** Scales a mechanic between `low` and `high` by confidence, passing through 1 at neutral. */
export function skillFactor(confidence: number, low: number, high: number): number {
  return confidence <= NEUTRAL_CONFIDENCE
    ? low + (1 - low) * (confidence / NEUTRAL_CONFIDENCE)
    : 1 + (high - 1) * ((confidence - NEUTRAL_CONFIDENCE) / (1 - NEUTRAL_CONFIDENCE));
}
