import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { canonicalTerms, describeTerms, parseTerms, rulesHash, type SpeciesCatalog } from '../src/challenges/terms.js';
import { goalMet, progressOf, WORLD_DAY_SECONDS } from '../src/challenges/goals.js';

const catalog: SpeciesCatalog = {
  ids: () => ['tiger', 'dhole', 'chital', 'elephant'],
  preyOf: (id) => (id === 'tiger' ? ['chital'] : id === 'dhole' ? ['chital'] : []),
  displayName: (id) => ({ tiger: 'Tiger', dhole: 'Dhole', chital: 'Chital', elephant: 'Asian elephant' })[id] ?? id,
};

describe('challenge terms', () => {
  it('accepts each template with its allowed values', () => {
    expect(parseTerms({ template: 'survive', speciesId: 'elephant', days: 3 }, catalog))
      .toEqual({ ok: true, terms: { template: 'survive', version: 1, speciesId: 'elephant', days: 3 } });
    expect(parseTerms({ template: 'hunt', speciesId: 'tiger' }, catalog))
      .toEqual({ ok: true, terms: { template: 'hunt', version: 1, speciesId: 'tiger' } });
    expect(parseTerms({ template: 'escape', speciesId: 'chital', count: 5 }, catalog))
      .toEqual({ ok: true, terms: { template: 'escape', version: 1, speciesId: 'chital', count: 5 } });
  });

  it('refuses unknown templates and species, odd values, a non-hunter hunt and an unhunted escape', () => {
    expect(parseTerms(null, catalog)).toEqual({ ok: false, error: 'terms_required' });
    expect(parseTerms({ template: 'fly', speciesId: 'tiger' }, catalog)).toEqual({ ok: false, error: 'unknown_template' });
    expect(parseTerms({ template: 'survive', speciesId: 'dragon', days: 1 }, catalog)).toEqual({ ok: false, error: 'unknown_species' });
    expect(parseTerms({ template: 'survive', speciesId: 'chital', days: 2 }, catalog)).toEqual({ ok: false, error: 'bad_days' });
    expect(parseTerms({ template: 'survive', speciesId: 'chital', days: '1' }, catalog)).toEqual({ ok: false, error: 'bad_days' });
    expect(parseTerms({ template: 'hunt', speciesId: 'chital' }, catalog)).toEqual({ ok: false, error: 'not_a_hunter' });
    expect(parseTerms({ template: 'escape', speciesId: 'elephant', count: 1 }, catalog)).toEqual({ ok: false, error: 'not_hunted' });
    expect(parseTerms({ template: 'escape', speciesId: 'chital', count: 6 }, catalog)).toEqual({ ok: false, error: 'bad_count' });
  });

  it('hashes one canonical text, whatever order or extra keys the input had', () => {
    const a = parseTerms({ days: 1, speciesId: 'chital', template: 'survive', note: 'ignored' }, catalog);
    const b = parseTerms({ template: 'survive', speciesId: 'chital', days: 1 }, catalog);
    if (!a.ok || !b.ok) throw new Error('parse failed');
    expect(canonicalTerms(a.terms)).toBe('{"template":"survive","version":1,"speciesId":"chital","days":1}');
    expect(rulesHash(a.terms)).toBe(rulesHash(b.terms));
    expect(rulesHash(a.terms)).toBe(keccak256(toBytes(`wildsentia-challenge:${canonicalTerms(a.terms)}`)));
    const c = parseTerms({ template: 'survive', speciesId: 'chital', days: 3 }, catalog);
    if (!c.ok) throw new Error('parse failed');
    expect(rulesHash(c.terms)).not.toBe(rulesHash(a.terms));
  });

  it('describes the goal in plain words', () => {
    const t = parseTerms({ template: 'escape', speciesId: 'chital', count: 1 }, catalog);
    if (!t.ok) throw new Error('parse failed');
    expect(describeTerms(t.terms, catalog)).toBe('Escape 1 predator attack as a chital');
  });
});

describe('challenge goals', () => {
  const start = { startedWorld: 1000, kills: 0, escapes: 0 };
  it('a survive goal is met only after the full number of forest days', () => {
    const terms = { template: 'survive', version: 1, speciesId: 'chital', days: 3 } as const;
    expect(goalMet(terms, start, 1000 + 3 * WORLD_DAY_SECONDS - 1)).toBe(false);
    expect(goalMet(terms, start, 1000 + 3 * WORLD_DAY_SECONDS)).toBe(true);
    expect(progressOf(terms, start, 1000 + 1.5 * WORLD_DAY_SECONDS)).toEqual({ done: 1.5, of: 3, unit: 'days' });
  });
  it('a hunt goal needs one kill; an escape goal needs its count', () => {
    const hunt = { template: 'hunt', version: 1, speciesId: 'tiger' } as const;
    expect(goalMet(hunt, start, 0)).toBe(false);
    expect(goalMet(hunt, { ...start, kills: 1 }, 0)).toBe(true);
    const escape = { template: 'escape', version: 1, speciesId: 'chital', count: 2 } as const;
    expect(goalMet(escape, { ...start, escapes: 1 }, 0)).toBe(false);
    expect(goalMet(escape, { ...start, escapes: 2 }, 0)).toBe(true);
    expect(progressOf(escape, { ...start, escapes: 4 }, 0)).toEqual({ done: 2, of: 2, unit: 'escapes' });
  });
});
