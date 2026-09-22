import type { Agent, SpeciesConfig } from '@vana/shared';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A full day without food takes hunger from 0 to roughly 0.8; water is faster. */
const HUNGER_PER_DAY = 0.8;
const THIRST_PER_DAY = 1.3;
const FEAR_DECAY_PER_HOUR = 0.42;

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
