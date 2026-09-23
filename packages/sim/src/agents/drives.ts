import type { Agent, SpeciesConfig } from '@vana/shared';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How fast an animal runs out.
 *
 * Starvation is slow and dehydration is fast, as they are in life: roughly a week without food
 * and under three days without water. The first version of this ran an order of magnitude
 * faster, so anything that missed a meal died within a day — which quietly starved every
 * wide-ranging predator and scavenger in the world while the herbivores, standing in their food,
 * never noticed.
 */
const HUNGER_PER_DAY = 0.14;
const THIRST_PER_DAY = 0.40;
const FEAR_DECAY_PER_HOUR = 0.42;

export { HUNGER_PER_DAY, THIRST_PER_DAY };

export function updateDrives(agent: Agent, _species: SpeciesConfig, hours: number): void {
  const days = hours / 24;
  const d = agent.drives;

  d.hunger = clamp01(d.hunger + HUNGER_PER_DAY * days);
  d.thirst = clamp01(d.thirst + THIRST_PER_DAY * days);

  const fatigueDelta =
    agent.state === 'resting' ? -0.10 * hours
    : agent.state === 'travelling' ? 0.035 * hours
    : 0.008 * hours;
  d.fatigue = clamp01(d.fatigue + fatigueDelta);

  d.fear = clamp01(d.fear - FEAR_DECAY_PER_HOUR * hours);
}
