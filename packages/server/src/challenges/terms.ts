import { keccak256, toBytes } from 'viem';
import { cleanText } from '../live/chat.js';

/**
 * What a challenge asks (docs/2026-10-09-challenges-design.md §3 and §13): a goal from a fixed
 * set, up to three rules the player must keep while playing, and an optional briefing. Every part
 * the prize depends on is something the server can measure. The hash of the canonical terms is
 * locked on chain when the challenge is created, so what a creator paid for never changes.
 */

/** Rules an attempt must keep; breaking one fails it at once. Coordinates are whole metres. */
export type Rule =
  | { type: 'zone'; x: number; z: number; radiusM: number }
  | { type: 'noRun' }
  | { type: 'herd'; maxDistanceM: number };

interface TermsBase { version: 1; speciesId: string; rules: Rule[]; briefing: string }
export type ChallengeTerms =
  | (TermsBase & { template: 'survive'; days: 1 | 3 | 7 | 14 })
  | (TermsBase & { template: 'hunt'; count: 1 | 2 | 3 | 4 | 5 })
  | (TermsBase & { template: 'escape'; count: 1 | 2 | 3 | 4 | 5 })
  | (TermsBase & { template: 'reach'; x: number; z: number });

/** What the terms check needs to know about the island and its species. */
export interface SpeciesCatalog {
  /** Every species id in the world. */
  ids(): string[];
  /** The species it hunts (empty for a non-predator). */
  preyOf(speciesId: string): string[];
  displayName(speciesId: string): string;
  /** True for a species that lives in a herd, troop or pack. */
  social(speciesId: string): boolean;
  /** True where an animal can stand. */
  onLand(x: number, z: number): boolean;
}

export const SURVIVE_DAYS = [1, 3, 7, 14] as const;
export const COUNTS = [1, 2, 3, 4, 5] as const;
export const ZONE_RADIUS_M = { min: 200, max: 3000 } as const;
export const HERD_DISTANCE_M = { min: 30, max: 200 } as const;
/** A reach goal is met within this distance of the target. */
export const REACH_WITHIN_M = 25;
/** ...and its animal must start at least this far away. */
export const REACH_MIN_START_M = 1000;
export const MAX_RULES = 3;
export const BRIEFING_MAX_CHARS = 280;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const wholeIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function parseRule(raw: unknown, catalog: SpeciesCatalog): Parsed<Rule> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bad_rule' };
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'zone':
      if (!wholeIn(r.radiusM, ZONE_RADIUS_M.min, ZONE_RADIUS_M.max)) return { ok: false, error: 'bad_zone_radius' };
      if (!wholeIn(r.x, -1e6, 1e6) || !wholeIn(r.z, -1e6, 1e6) || !catalog.onLand(r.x, r.z)) return { ok: false, error: 'zone_not_on_land' };
      return { ok: true, value: { type: 'zone', x: r.x, z: r.z, radiusM: r.radiusM } };
    case 'noRun': return { ok: true, value: { type: 'noRun' } };
    case 'herd':
      if (!wholeIn(r.maxDistanceM, HERD_DISTANCE_M.min, HERD_DISTANCE_M.max)) return { ok: false, error: 'bad_herd_distance' };
      return { ok: true, value: { type: 'herd', maxDistanceM: r.maxDistanceM } };
    default: return { ok: false, error: 'unknown_rule' };
  }
}

export function parseTerms(input: unknown, catalog: SpeciesCatalog):
  { ok: true; terms: ChallengeTerms } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'terms_required' };
  const raw = input as Record<string, unknown>;
  const speciesId = typeof raw.speciesId === 'string' ? raw.speciesId : '';
  if (!catalog.ids().includes(speciesId)) return { ok: false, error: 'unknown_species' };

  // Rules: at most three, one of each kind.
  const rawRules = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(rawRules) || rawRules.length > MAX_RULES) return { ok: false, error: 'bad_rules' };
  const rules: Rule[] = [];
  for (const r of rawRules) {
    const parsed = parseRule(r, catalog);
    if (!parsed.ok) return parsed;
    if (rules.some((x) => x.type === parsed.value.type)) return { ok: false, error: 'duplicate_rule' };
    rules.push(parsed.value);
  }
  if (rules.some((r) => r.type === 'herd') && !catalog.social(speciesId)) return { ok: false, error: 'not_a_herd_species' };

  // Briefing: optional plain text, cleaned like agent chat (no links, addresses or keys).
  let briefing = '';
  if (raw.briefing !== undefined && raw.briefing !== '') {
    const clean = cleanText(raw.briefing, BRIEFING_MAX_CHARS);
    if (!clean.ok) return { ok: false, error: `briefing_${clean.error}` };
    briefing = clean.text;
  }
  const base = { version: 1 as const, speciesId, rules, briefing };
  const zone = rules.find((r) => r.type === 'zone');

  switch (raw.template) {
    case 'survive':
      if (!SURVIVE_DAYS.includes(raw.days as 1)) return { ok: false, error: 'bad_days' };
      return { ok: true, terms: { template: 'survive', ...base, days: raw.days as 1 | 3 | 7 | 14 } };
    case 'hunt': {
      const count = raw.count === undefined ? 1 : raw.count;
      if (!COUNTS.includes(count as 1)) return { ok: false, error: 'bad_count' };
      if (catalog.preyOf(speciesId).length === 0) return { ok: false, error: 'not_a_hunter' };
      // A committed hunter sprints: forbidding running would make the goal impossible.
      if (rules.some((r) => r.type === 'noRun')) return { ok: false, error: 'no_run_cannot_hunt' };
      return { ok: true, terms: { template: 'hunt', ...base, count: count as 1 } };
    }
    case 'escape': {
      if (!COUNTS.includes(raw.count as 1)) return { ok: false, error: 'bad_count' };
      const hunted = new Set(catalog.ids().flatMap((id) => catalog.preyOf(id)));
      if (!hunted.has(speciesId)) return { ok: false, error: 'not_hunted' };
      return { ok: true, terms: { template: 'escape', ...base, count: raw.count as 1 } };
    }
    case 'reach': {
      if (!wholeIn(raw.x, -1e6, 1e6) || !wholeIn(raw.z, -1e6, 1e6) || !catalog.onLand(raw.x, raw.z)) return { ok: false, error: 'target_not_on_land' };
      if (zone && Math.hypot(raw.x - zone.x, raw.z - zone.z) > zone.radiusM - REACH_WITHIN_M) return { ok: false, error: 'target_outside_zone' };
      // The start must be inside the zone and a kilometre from the target: the zone has to reach that far.
      if (zone && Math.hypot(raw.x - zone.x, raw.z - zone.z) + zone.radiusM < REACH_MIN_START_M) return { ok: false, error: 'zone_too_small_for_reach' };
      return { ok: true, terms: { template: 'reach', ...base, x: raw.x, z: raw.z } };
    }
    default:
      return { ok: false, error: 'unknown_template' };
  }
}

function canonicalRule(r: Rule): Record<string, unknown> {
  switch (r.type) {
    case 'zone': return { type: 'zone', x: r.x, z: r.z, radiusM: r.radiusM };
    case 'noRun': return { type: 'noRun' };
    case 'herd': return { type: 'herd', maxDistanceM: r.maxDistanceM };
  }
}

/** The one text the rules hash is taken over: fixed key order, rules in the order given, no spaces. */
export function canonicalTerms(t: ChallengeTerms): string {
  const goal = t.template === 'survive' ? { days: t.days } : t.template === 'reach' ? { x: t.x, z: t.z } : { count: t.count };
  return JSON.stringify({ template: t.template, version: 1, speciesId: t.speciesId, ...goal,
    rules: t.rules.map(canonicalRule), briefing: t.briefing });
}

export function rulesHash(terms: ChallengeTerms): `0x${string}` {
  return keccak256(toBytes(`wildsentia-challenge:${canonicalTerms(terms)}`));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case 'zone': return `stay within ${rule.radiusM} m of (${rule.x}, ${rule.z})`;
    case 'noRun': return 'never run';
    case 'herd': return `stay within ${rule.maxDistanceM} m of your own kind`;
  }
}

/** A species name inside a sentence: lower case, but a proper adjective (Asian) keeps its capital. */
function speciesInSentence(displayName: string): string {
  return displayName.split(' ').map((word, i) => (i === 0 && /^(Asian)$/.test(word) ? word : word.toLowerCase())).join(' ');
}
const article = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

export function describeTerms(terms: ChallengeTerms, catalog: SpeciesCatalog): string {
  const name = speciesInSentence(catalog.displayName(terms.speciesId)), aName = article(name);
  const goal = (() => {
    switch (terms.template) {
      case 'survive': return `Keep ${aName} alive for ${plural(terms.days, 'forest day')}`;
      case 'hunt': return terms.count === 1 ? `Make a kill as ${aName}` : `Make ${terms.count} kills as ${aName}`;
      case 'escape': return `Escape ${plural(terms.count, 'predator attack')} as ${aName}`;
      case 'reach': return `Reach (${terms.x}, ${terms.z}) alive as ${aName}`;
    }
  })();
  return terms.rules.length ? `${goal}; ${terms.rules.map(describeRule).join('; ')}` : goal;
}
