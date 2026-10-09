import { keccak256, toBytes } from 'viem';

/**
 * The goals a challenge can set (docs/2026-10-09-challenges-design.md §3). Templates only, so
 * the server can judge every attempt without argument. The hash of the canonical terms is
 * locked on chain when the challenge is created, so the rules a creator paid for never change.
 */
export type ChallengeTerms =
  | { template: 'survive'; version: 1; speciesId: string; days: 1 | 3 | 7 }
  | { template: 'hunt'; version: 1; speciesId: string }
  | { template: 'escape'; version: 1; speciesId: string; count: 1 | 2 | 3 | 4 | 5 };

/** What the terms check needs to know about the island's species. */
export interface SpeciesCatalog {
  /** Every species id in the world. */
  ids(): string[];
  /** The species it hunts (empty for a non-predator). */
  preyOf(speciesId: string): string[];
  displayName(speciesId: string): string;
}

export const SURVIVE_DAYS = [1, 3, 7] as const;
export const ESCAPE_COUNTS = [1, 2, 3, 4, 5] as const;

/** Species hunted by at least one predator. */
function huntedSpecies(catalog: SpeciesCatalog): Set<string> {
  return new Set(catalog.ids().flatMap((id) => catalog.preyOf(id)));
}

export function parseTerms(input: unknown, catalog: SpeciesCatalog):
  { ok: true; terms: ChallengeTerms } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'terms_required' };
  const raw = input as Record<string, unknown>;
  const speciesId = typeof raw.speciesId === 'string' ? raw.speciesId : '';
  if (!catalog.ids().includes(speciesId)) return { ok: false, error: 'unknown_species' };
  switch (raw.template) {
    case 'survive': {
      const days = raw.days;
      if (!SURVIVE_DAYS.includes(days as 1)) return { ok: false, error: 'bad_days' };
      return { ok: true, terms: { template: 'survive', version: 1, speciesId, days: days as 1 | 3 | 7 } };
    }
    case 'hunt':
      if (catalog.preyOf(speciesId).length === 0) return { ok: false, error: 'not_a_hunter' };
      return { ok: true, terms: { template: 'hunt', version: 1, speciesId } };
    case 'escape': {
      const count = raw.count;
      if (!ESCAPE_COUNTS.includes(count as 1)) return { ok: false, error: 'bad_count' };
      if (!huntedSpecies(catalog).has(speciesId)) return { ok: false, error: 'not_hunted' };
      return { ok: true, terms: { template: 'escape', version: 1, speciesId, count: count as 1 | 2 | 3 | 4 | 5 } };
    }
    default:
      return { ok: false, error: 'unknown_template' };
  }
}

/** The one text the rules hash is taken over: fixed key order, no spaces. */
export function canonicalTerms(terms: ChallengeTerms): string {
  switch (terms.template) {
    case 'survive': return JSON.stringify({ template: 'survive', version: 1, speciesId: terms.speciesId, days: terms.days });
    case 'hunt': return JSON.stringify({ template: 'hunt', version: 1, speciesId: terms.speciesId });
    case 'escape': return JSON.stringify({ template: 'escape', version: 1, speciesId: terms.speciesId, count: terms.count });
  }
}

export function rulesHash(terms: ChallengeTerms): `0x${string}` {
  return keccak256(toBytes(`wildsentia-challenge:${canonicalTerms(terms)}`));
}

export function describeTerms(terms: ChallengeTerms, catalog: SpeciesCatalog): string {
  const name = catalog.displayName(terms.speciesId).toLowerCase();
  switch (terms.template) {
    case 'survive': return `Keep a ${name} alive for ${terms.days} forest day${terms.days === 1 ? '' : 's'}`;
    case 'hunt': return `Make a kill as a ${name}`;
    case 'escape': return `Escape ${terms.count} predator attack${terms.count === 1 ? '' : 's'} as a ${name}`;
  }
}
