import { formatWorldTime, seasonAt, type Agent, type WorldEvent } from '@vana/shared';
import type { Question, SystemOne } from './typesafe.js';
import { WindowRateLimit } from '../limits.js';

/**
 * Observer insights from TypeSafe AI's Jev: estimates for viewers, never inputs to nature.
 *
 * - Outlook: what a followed animal is most likely to do over the next hour, as probabilities
 *   over its species' possible goals, judged from its saved needs and surroundings.
 * - Highlights: which of the latest recorded events a viewer would find most remarkable, so
 *   a hunt or a birth is not buried under a dozen identical carcass visits.
 *
 * Each answer is cached for its checkpoint (the state it was asked about cannot change until
 * the next one), identical concurrent requests share one call, and a daily call budget caps
 * spending. Without a key, or past the budget, the insights are simply absent.
 */

export interface OutlookChoice { goal: string; label: string; probability: number }
export interface Outlook { asOfWorldTime: number; model: string; confidence: number; choices: OutlookChoice[] }
export interface Highlight { event: WorldEvent; score: number; confidence: number }
export interface Highlights { asOfWorldTime: number; model: string; highlights: Highlight[] }

export type InsightUnavailable = 'not_configured' | 'budget_exhausted' | 'unavailable';
export type InsightResult<T> = { ok: true; value: T } | { ok: false; reason: InsightUnavailable };

/** What each goal looks like to a viewer; a species is offered only the goals open to it. */
export const GOAL_LABELS: Record<string, string> = {
  find_food: 'Look for food: graze, browse or eat',
  find_water: 'Go to water and drink',
  rest: 'Rest or sleep',
  wander: 'Move on through its range',
  hunt: 'Hunt prey',
  scavenge: 'Feed on a carcass',
  flee: 'Flee from danger',
  breed: 'Look for a mate',
  care_for_young: 'Stay with and look after its young',
  follow_parent: 'Follow its mother',
};

export interface SpeciesFacts { displayName: string; hunts: boolean; scavenges: boolean }

/** The goals a viewer could plausibly see this animal take next. */
export function outlookGoals(agent: Pick<Agent, 'lifeStage' | 'dependentOn' | 'offspringIds'>, species: SpeciesFacts): string[] {
  const goals = ['find_food', 'find_water', 'rest', 'wander', 'flee'];
  if (species.hunts && agent.lifeStage !== 'newborn' && agent.dependentOn === null) goals.push('hunt');
  if (species.scavenges) goals.push('scavenge');
  if (agent.lifeStage === 'adult' || agent.lifeStage === 'elder') goals.push('breed');
  if (agent.offspringIds.length > 0) goals.push('care_for_young');
  if (agent.dependentOn !== null) goals.push('follow_parent');
  return goals;
}

const percent = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

function partOfDay(worldTime: number): string {
  const hour = Math.floor((((worldTime % 86400) + 86400) % 86400) / 3600);
  return hour < 5 ? 'night' : hour < 7 ? 'dawn' : hour < 11 ? 'morning' : hour < 15 ? 'midday'
    : hour < 18 ? 'afternoon' : hour < 20 ? 'dusk' : 'night';
}

/** The state Jev judges: only saved facts a viewer could also read on the animal's card. */
export function outlookState(agent: Agent, species: SpeciesFacts, worldTime: number,
  patch: { habitat: string; waterVolume: number; grass: number } | undefined, profile?: string) {
  return {
    animal: {
      species: species.displayName, sex: agent.sex, lifeStage: agent.lifeStage,
      ageYears: Math.round(agent.ageDays / 36) / 10,
      doingNow: agent.state, currentGoal: GOAL_LABELS[agent.currentGoal] ?? agent.currentGoal,
      needsPercent: { hunger: percent(agent.drives.hunger), thirst: percent(agent.drives.thirst),
        fatigue: percent(agent.drives.fatigue), fear: percent(agent.drives.fear) },
      ...(agent.illness?.phase === 'active' ? { ill: true } : {}),
      ...(agent.wound ? { wounded: true } : {}),
      ...(agent.pregnantSince !== null ? { pregnant: true } : {}),
      ...(agent.dependentOn !== null ? { dependsOnMother: true } : {}),
      youngCount: agent.offspringIds.length,
    },
    surroundings: {
      timeOfDay: partOfDay(worldTime), season: seasonAt(worldTime, profile),
      ...(patch ? { habitat: patch.habitat, surfaceWaterHere: patch.waterVolume > 0,
        grassHere: patch.grass > 3000 ? 'plenty' : patch.grass > 800 ? 'some' : 'little' } : {}),
    },
  };
}

const HIGHLIGHT_LEVELS = [
  'Routine: happens many times a day, such as grazing, drinking, resting or feeding on a carcass',
  'Minor: a small moment worth a glance',
  'Notable: worth pointing out to someone watching',
  'Remarkable: a hunt, a birth, a death, an illness or unusual behaviour',
  'Exceptional: a rare and dramatic moment in the life of the forest',
];
/** Scores at or above this (0-4) are offered as highlights. */
export const HIGHLIGHT_MIN_SCORE = 2;
const HIGHLIGHT_BATCH = 12;

/** An animal's species from its id (`blue_duiker_00ab` → `blue_duiker`): all but the last part. */
const speciesOfActor = (id: string) => id.lastIndexOf('_') > 0 ? id.slice(0, id.lastIndexOf('_')) : id;

/** One entry per kind of moment: the newest of a dozen identical carcass visits stands for them all. */
export function distinctEvents(events: readonly WorldEvent[], limit = HIGHLIGHT_BATCH): WorldEvent[] {
  const seen = new Set<string>(), result: WorldEvent[] = [];
  for (const event of events) {
    const key = `${event.type}|${event.outcome}|${event.actors.slice(0, 2).map(speciesOfActor).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push(event);
    if (result.length === limit) break;
  }
  return result;
}

export function highlightState(events: readonly WorldEvent[], speciesName: (id: string) => string, profile?: string) {
  return {
    island: profile === 'congo_v1' ? 'A simulated forest inspired by the Congo Basin, with a great river and wild animals'
      : 'A simulated tropical island forest with wild animals and one small village',
    events: Object.fromEntries(events.map((e, i) => [`e${i}`, {
      what: e.type.replaceAll('_', ' '), outcome: e.outcome,
      who: e.actors.slice(0, 2).map((id) => id.startsWith('person_') ? 'villager' : speciesName(speciesOfActor(id))),
      when: formatWorldTime(e.worldTime, profile),
    }])),
  };
}

export class Insights {
  readonly #cache = new Map<string, unknown>();
  readonly #inflight = new Map<string, Promise<InsightResult<unknown>>>();
  #day = '';
  #calls = 0;

  /**
   * One visitor network's share of the day's calls (the security audit of 17 November 2026 L4): a
   * twentieth of the budget, so one network asking after every animal cannot spend it all.
   */
  readonly #perNetwork: WindowRateLimit;

  constructor(private readonly systemOne: SystemOne | null, private readonly dailyCalls = 1000,
    private readonly now: () => number = Date.now) {
    this.#perNetwork = new WindowRateLimit(Math.max(20, Math.floor(dailyCalls / 20)), 5000, 86_400_000);
  }

  /** The world's terrain profile (its calendar and its description); set by the server (Congo 1B). */
  profile: string | undefined;

  get configured(): boolean { return this.systemOne !== null; }
  get callsToday(): number { this.#rollDay(); return this.#calls; }

  #rollDay(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.#day) { this.#day = day; this.#calls = 0; }
  }

  async #ask<T>(key: string, work: (ask: SystemOne) => Promise<T>, network?: string): Promise<InsightResult<T>> {
    if (!this.systemOne) return { ok: false, reason: 'not_configured' };
    if (this.#cache.has(key)) return { ok: true, value: this.#cache.get(key) as T };
    const pending = this.#inflight.get(key);
    if (pending) return pending as Promise<InsightResult<T>>;
    this.#rollDay();
    if (this.#calls >= this.dailyCalls) return { ok: false, reason: 'budget_exhausted' };
    // Only a new question counts against the network: cached and in-flight answers are free.
    if (network !== undefined && !this.#perNetwork.take(network, this.now())) return { ok: false, reason: 'budget_exhausted' };
    this.#calls++;
    const ask = this.systemOne;
    const promise = (async (): Promise<InsightResult<T>> => {
      try {
        const value = await work(ask);
        this.#cache.set(key, value);
        // Bounded: old checkpoints' answers are never asked for again.
        if (this.#cache.size > 400) this.#cache.delete(this.#cache.keys().next().value!);
        return { ok: true, value };
      } catch {
        return { ok: false, reason: 'unavailable' };
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, promise);
    return promise;
  }

  outlook(agent: Agent, species: SpeciesFacts, worldTime: number,
    patch: { habitat: string; waterVolume: number; grass: number } | undefined, network?: string): Promise<InsightResult<Outlook>> {
    return this.#ask(`outlook:${agent.id}@${worldTime}`, async (ask) => {
      const goals = outlookGoals(agent, species);
      const question: Question = {
        type: 'choice',
        instructions: 'Given this wild animal\'s current needs and surroundings, what is it most likely to do over the next hour?',
        criteria: Object.fromEntries(goals.map((g) => [g, GOAL_LABELS[g]!])),
      };
      const result = await ask(outlookState(agent, species, worldTime, patch, this.profile), { next: question });
      const answer = result.answers.next!;
      if (answer.type !== 'choice') throw new Error('unexpected answer');
      const choices = goals.map((goal) => ({ goal, label: GOAL_LABELS[goal]!, probability: answer.probabilities[goal] ?? 0 }))
        .sort((a, b) => b.probability - a.probability);
      return { asOfWorldTime: worldTime, model: result.model, confidence: answer.confidence, choices };
    }, network);
  }

  highlights(events: readonly WorldEvent[], worldTime: number, nextSequence: number,
    speciesName: (id: string) => string): Promise<InsightResult<Highlights>> {
    const batch = distinctEvents(events);
    if (batch.length === 0) return Promise.resolve({ ok: true, value: { asOfWorldTime: worldTime, model: '', highlights: [] } });
    return this.#ask(`highlights:${worldTime}:${nextSequence}`, async (ask) => {
      const questions = Object.fromEntries(batch.map((_, i) => [`e${i}`, {
        type: 'score' as const,
        instructions: `How remarkable is event \`events.e${i}\` for someone watching this ${this.profile === 'congo_v1' ? 'forest' : 'island'}'s wildlife?`,
        criteria: HIGHLIGHT_LEVELS,
      }]));
      const result = await ask(highlightState(batch, speciesName, this.profile), questions);
      const highlights = batch.map((event, i) => {
        const answer = result.answers[`e${i}`]!;
        return answer.type === 'score' ? { event, score: answer.score, confidence: answer.confidence } : null;
      }).filter((h): h is Highlight => h !== null && h.score >= HIGHLIGHT_MIN_SCORE)
        .sort((a, b) => b.score - a.score);
      return { asOfWorldTime: worldTime, model: result.model, highlights: oneMomentEach(highlights).slice(0, 3) };
    });
  }
}

/**
 * A kill is recorded twice, as the hunt and as the prey's death, with the same two animals;
 * show that moment once, by its higher-scored record.
 */
export function oneMomentEach(highlights: readonly Highlight[]): Highlight[] {
  const seen = new Set<string>(), result: Highlight[] = [];
  for (const h of highlights) {
    const who = [...h.event.actors].sort().join('|');
    if (h.event.actors.length > 1 && seen.has(who)) continue;
    seen.add(who); result.push(h);
  }
  return result;
}
