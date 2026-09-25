import type { EventType, WorldEvent } from '../types/event.js';

/** The events a recap can say anything about. Everything else is routine. */
export const RECAP_EVENT_TYPES = [
  'born', 'died', 'hunt', 'courtship', 'skill_taught', 'life_stage', 'dispersed', 'fled', 'tree_climbed',
  'emigration', 'immigration', 'parent_lost', 'disease_contracted',
  'disease_symptomatic', 'disease_recovered', 'disease_fatal',
  'wounded', 'wound_infected', 'wound_healed', 'wound_infection_fatal',
] as const satisfies readonly EventType[];

export interface RecapLine {
  /** The record this line was written from. Every line can be checked against it. */
  eventId: string;
  worldTime: number;
  text: string;
}

const speciesOf = (id: string | undefined): string => (id ?? 'animal').split('_')[0]!;

const SKILL: Record<string, { learned: string; showed: string }> = {
  water_locations: { learned: 'where the water is', showed: 'where the water is' },
  forage_efficiency: { learned: 'how to forage', showed: 'how to forage' },
  predator_avoidance: { learned: 'how to escape predators', showed: 'how to escape predators' },
  stalk_technique: { learned: 'how to stalk', showed: 'how to stalk' },
};

const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/**
 * One event, told from one animal's side, or null when it is routine or not about it. The
 * "while you were away" recap (spec §10.4) is made of these: what changed, never every mouthful.
 */
export function recapLine(event: WorldEvent, subjectId: string): RecapLine | null {
  const [first, second, third] = event.actors;
  const line = (text: string): RecapLine => ({ eventId: event.id, worldTime: event.worldTime, text });

  switch (event.type) {
    case 'born':
      if (subjectId === first) return line('Was born');
      if (subjectId === second) return line(`Gave birth to ${first}`);
      if (subjectId === third) return line(`Fathered ${first}`);
      return null;
    case 'died':
      // The killer's side is its hunt.
      return subjectId === first ? line(`Died — ${String(event.conditions.cause ?? 'unknown cause')}`) : null;
    case 'disease_contracted':
      return subjectId === first ? line('Contracted a modelled illness after eating carrion') : null;
    case 'disease_symptomatic':
      return subjectId === first ? line('Showed signs of illness') : null;
    case 'disease_recovered':
      return subjectId === first ? line('Recovered from an illness') : null;
    case 'disease_fatal':
      return subjectId === first ? line('Illness became fatal') : null;
    case 'wounded':
      return subjectId === first ? line('Sustained a modelled wound after contact in a failed hunt') : null;
    case 'wound_infected':
      return subjectId === first ? line('A modelled wound became infected') : null;
    case 'wound_healed':
      return subjectId === first ? line('A modelled wound healed') : null;
    case 'wound_infection_fatal':
      return subjectId === first ? line('A modelled wound infection became fatal') : null;
    case 'hunt':
      // A closing approach is not an escape; a finite tick ending is not an observed kill.
      if (event.outcome !== 'success' && ['approaching', 'time_exhausted', 'out_of_range'].includes(String(event.conditions.stage))) {
        return subjectId === first ? line('Hunting attempt unresolved — no capture recorded') : null;
      }
      if (event.outcome !== 'success' && event.conditions.stage === 'chase_abandoned') {
        if (event.encounter && !event.encounter.samples.some((s) => s.phase === 'chase')) {
          return subjectId === first ? line('Abandoned a hunting attempt before a chase') : null;
        }
        if (subjectId === first) return line('Abandoned a chase without a capture');
        if (subjectId === second) return line(`Survived a chase by ${article(speciesOf(first))}`);
        return null;
      }
      if (subjectId === first) {
        return event.outcome === 'success'
          ? line(`Killed ${article(speciesOf(second))}`)
          : line(`A hunt failed — the ${speciesOf(second)} escaped`);
      }
      if (subjectId === second && event.outcome !== 'success') return line(`Escaped ${article(speciesOf(first))}`);
      return null;
    case 'courtship':
      if (event.outcome !== 'success' || second === undefined) return null;
      if (subjectId === first) return line(`Mated with ${second}`);
      if (subjectId === second) return line(`Mated with ${first}`);
      return null;
    case 'skill_taught': {
      const skill = SKILL[String(event.conditions.skill)];
      if (skill === undefined) return null;
      if (subjectId === first) return line(`Learned ${skill.learned} from ${second}`);
      if (subjectId === second) return line(`Showed ${first} ${skill.showed}`);
      return null;
    }
    case 'life_stage':
      return subjectId === first ? line(`Grew into ${article(String(event.conditions.stage))}`) : null;
    case 'dispersed':
      if (subjectId === first) return line('Left its mother to live on its own');
      if (subjectId === second) return line(`${first} left to live on its own`);
      return null;
    case 'parent_lost':
      // Absence can mean death or emigration; do not invent a cause or successful adoption.
      return subjectId === first ? line(`Lost parental care from ${second}`) : null;
    case 'fled':
      return subjectId === first ? line('Ran from danger') : null;
    case 'tree_climbed': {
      if (subjectId !== first) return null;
      const ascent = event.conditions.direction === 'ascend';
      const distance = event.effects.verticalDistanceM;
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0)
        return line(ascent ? 'Approached a tree; no ascent recorded' : 'Attempted to descend; no vertical movement recorded');
      return line(ascent
        ? event.outcome === 'success' ? 'Climbed into a tree' : 'Partly climbed a tree'
        : event.outcome === 'success' ? 'Descended from a tree' : 'Partly descended from a tree');
    }
    case 'emigration':
      return subjectId === first ? line('Walked out of the forest') : null;
    case 'immigration':
      return subjectId === first ? line('Walked into the forest') : null;
    default:
      return null;
  }
}

/** A whole recap: lines in time order, with runs of the same line folded into one. */
export function recapFor(events: readonly WorldEvent[], subjectId: string): RecapLine[] {
  const lines = [...events]
    .sort((a, b) => a.worldTime - b.worldTime)
    .map((event) => recapLine(event, subjectId))
    .filter((l): l is RecapLine => l !== null);

  const folded: Array<RecapLine & { count: number }> = [];
  for (const l of lines) {
    const last = folded[folded.length - 1];
    if (last !== undefined && last.text === l.text) { last.count++; continue; }
    folded.push({ ...l, count: 1 });
  }
  return folded.map(({ count, ...l }) => (count > 1 ? { ...l, text: `${l.text} ×${count}` } : l));
}
