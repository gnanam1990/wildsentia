import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { canonicalTerms, describeTerms, parseTerms, rulesHash, type SpeciesCatalog } from '../src/challenges/terms.js';
import { goalMet, progressOf, WORLD_DAY_SECONDS } from '../src/challenges/goals.js';

const catalog: SpeciesCatalog = {
  ids: () => ['tiger', 'dhole', 'chital', 'elephant'],
  preyOf: (id) => (id === 'tiger' ? ['chital'] : id === 'dhole' ? ['chital'] : []),
  displayName: (id) => ({ tiger: 'Tiger', dhole: 'Dhole', chital: 'Chital', elephant: 'Asian elephant' })[id] ?? id,
  social: (id) => id !== 'tiger',
  // Land everywhere except the sea east of x = 5000.
  onLand: (x) => x < 5000,
};
const none = { rules: [], briefing: '' };

describe('challenge terms', () => {
  it('accepts each template with its allowed values', () => {
    expect(parseTerms({ template: 'survive', speciesId: 'elephant', days: 3 }, catalog))
      .toEqual({ ok: true, terms: { template: 'survive', version: 1, speciesId: 'elephant', days: 3, ...none } });
    expect(parseTerms({ template: 'hunt', speciesId: 'tiger' }, catalog))
      .toEqual({ ok: true, terms: { template: 'hunt', version: 1, speciesId: 'tiger', count: 1, ...none } });
    expect(parseTerms({ template: 'hunt', speciesId: 'tiger', count: 3 }, catalog))
      .toEqual({ ok: true, terms: { template: 'hunt', version: 1, speciesId: 'tiger', count: 3, ...none } });
    expect(parseTerms({ template: 'escape', speciesId: 'chital', count: 5 }, catalog))
      .toEqual({ ok: true, terms: { template: 'escape', version: 1, speciesId: 'chital', count: 5, ...none } });
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1200, z: 300 }, catalog))
      .toEqual({ ok: true, terms: { template: 'reach', version: 1, speciesId: 'chital', x: 1200, z: 300, ...none } });
    for (const days of [1, 3, 7, 14]) expect(parseTerms({ template: 'survive', speciesId: 'chital', days }, catalog).ok).toBe(true);
  });

  it('refuses unknown templates and species, odd values, a non-hunter hunt and an unhunted escape', () => {
    expect(parseTerms(null, catalog)).toEqual({ ok: false, error: 'terms_required' });
    expect(parseTerms({ template: 'fly', speciesId: 'tiger' }, catalog)).toEqual({ ok: false, error: 'unknown_template' });
    expect(parseTerms({ template: 'survive', speciesId: 'dragon', days: 1 }, catalog)).toEqual({ ok: false, error: 'unknown_species' });
    expect(parseTerms({ template: 'survive', speciesId: 'chital', days: 2 }, catalog)).toEqual({ ok: false, error: 'bad_days' });
    expect(parseTerms({ template: 'survive', speciesId: 'chital', days: '1' }, catalog)).toEqual({ ok: false, error: 'bad_days' });
    expect(parseTerms({ template: 'hunt', speciesId: 'chital' }, catalog)).toEqual({ ok: false, error: 'not_a_hunter' });
    expect(parseTerms({ template: 'hunt', speciesId: 'tiger', count: 6 }, catalog)).toEqual({ ok: false, error: 'bad_count' });
    expect(parseTerms({ template: 'escape', speciesId: 'elephant', count: 1 }, catalog)).toEqual({ ok: false, error: 'not_hunted' });
    expect(parseTerms({ template: 'escape', speciesId: 'chital', count: 6 }, catalog)).toEqual({ ok: false, error: 'bad_count' });
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 6000, z: 0 }, catalog)).toEqual({ ok: false, error: 'target_not_on_land' });
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1.5, z: 0 }, catalog)).toEqual({ ok: false, error: 'target_not_on_land' });
  });

  it('takes up to three rules, one of each kind, each within its limits', () => {
    const zone = { type: 'zone', x: 1000, z: 1000, radiusM: 500 };
    const ok = parseTerms({ template: 'survive', speciesId: 'chital', days: 1,
      rules: [zone, { type: 'noRun' }, { type: 'herd', maxDistanceM: 50 }] }, catalog);
    expect(ok).toEqual({ ok: true, terms: { template: 'survive', version: 1, speciesId: 'chital', days: 1, briefing: '',
      rules: [zone, { type: 'noRun' }, { type: 'herd', maxDistanceM: 50 }] } });
    const survive = (rules: unknown) => parseTerms({ template: 'survive', speciesId: 'chital', days: 1, rules }, catalog);
    expect(survive('zone')).toEqual({ ok: false, error: 'bad_rules' });
    expect(survive([zone, zone, zone, zone])).toEqual({ ok: false, error: 'bad_rules' });
    expect(survive([{ type: 'noRun' }, { type: 'noRun' }])).toEqual({ ok: false, error: 'duplicate_rule' });
    expect(survive([{ type: 'fly' }])).toEqual({ ok: false, error: 'unknown_rule' });
    expect(survive([7])).toEqual({ ok: false, error: 'bad_rule' });
    expect(survive([{ ...zone, radiusM: 199 }])).toEqual({ ok: false, error: 'bad_zone_radius' });
    expect(survive([{ ...zone, radiusM: 3001 }])).toEqual({ ok: false, error: 'bad_zone_radius' });
    expect(survive([{ ...zone, x: 7000 }])).toEqual({ ok: false, error: 'zone_not_on_land' });
    expect(survive([{ type: 'herd', maxDistanceM: 29 }])).toEqual({ ok: false, error: 'bad_herd_distance' });
    expect(survive([{ type: 'herd', maxDistanceM: 201 }])).toEqual({ ok: false, error: 'bad_herd_distance' });
    expect(parseTerms({ template: 'survive', speciesId: 'tiger', days: 1, rules: [{ type: 'herd', maxDistanceM: 50 }] }, catalog))
      .toEqual({ ok: false, error: 'not_a_herd_species' });
    // A committed hunter sprints, so a hunt goal under "never run" could never be met.
    expect(parseTerms({ template: 'hunt', speciesId: 'tiger', rules: [{ type: 'noRun' }] }, catalog))
      .toEqual({ ok: false, error: 'no_run_cannot_hunt' });
    // A reach target must leave room inside the zone to be reached.
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1480, z: 1000, rules: [zone] }, catalog))
      .toEqual({ ok: false, error: 'target_outside_zone' });
    // ...and a start inside the zone must be able to lie a kilometre from it (500 m zone: never).
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1475, z: 1000, rules: [zone] }, catalog))
      .toEqual({ ok: false, error: 'zone_too_small_for_reach' });
    const big = { type: 'zone', x: 1000, z: 1000, radiusM: 800 };
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1100, z: 1000, rules: [big] }, catalog))
      .toEqual({ ok: false, error: 'zone_too_small_for_reach' });
    expect(parseTerms({ template: 'reach', speciesId: 'chital', x: 1200, z: 1000, rules: [big] }, catalog).ok).toBe(true);
  });

  it('keeps a cleaned briefing and refuses one with links, keys or too many characters', () => {
    const brief = (briefing: unknown) => parseTerms({ template: 'survive', speciesId: 'chital', days: 1, briefing }, catalog);
    expect(brief('  Stay   near the​ river.  ')).toMatchObject({ ok: true, terms: { briefing: 'Stay near the river.' } });
    expect(brief('')).toMatchObject({ ok: true, terms: { briefing: '' } });
    expect(brief('see https://example.com')).toEqual({ ok: false, error: 'briefing_no_links' });
    expect(brief(`pay 0x${'a'.repeat(40)}`)).toEqual({ ok: false, error: 'briefing_no_addresses_or_keys' });
    expect(brief(`${'ab '.repeat(93)}ab`)).toEqual({ ok: false, error: 'briefing_bad_text' });
    expect(brief(`${'ab '.repeat(93)}a`).ok).toBe(true);
    expect(brief(5)).toEqual({ ok: false, error: 'briefing_bad_text' });
  });

  it('hashes one canonical text, whatever order or extra keys the input had, covering rules and briefing', () => {
    const a = parseTerms({ days: 1, speciesId: 'chital', template: 'survive', note: 'ignored' }, catalog);
    const b = parseTerms({ template: 'survive', speciesId: 'chital', days: 1 }, catalog);
    if (!a.ok || !b.ok) throw new Error('parse failed');
    expect(canonicalTerms(a.terms)).toBe('{"template":"survive","version":1,"speciesId":"chital","days":1,"rules":[],"briefing":""}');
    expect(rulesHash(a.terms)).toBe(rulesHash(b.terms));
    expect(rulesHash(a.terms)).toBe(keccak256(toBytes(`wildsentia-challenge:${canonicalTerms(a.terms)}`)));
    const c = parseTerms({ template: 'survive', speciesId: 'chital', days: 3 }, catalog);
    const ruled = parseTerms({ template: 'survive', speciesId: 'chital', days: 1, rules: [{ radiusM: 400, z: 2, type: 'zone', x: 1, extra: 1 }] }, catalog);
    const briefed = parseTerms({ template: 'survive', speciesId: 'chital', days: 1, briefing: 'Go west.' }, catalog);
    if (!c.ok || !ruled.ok || !briefed.ok) throw new Error('parse failed');
    expect(canonicalTerms(ruled.terms)).toBe('{"template":"survive","version":1,"speciesId":"chital","days":1,'
      + '"rules":[{"type":"zone","x":1,"z":2,"radiusM":400}],"briefing":""}');
    const hashes = new Set([a, c, ruled, briefed].map((t) => rulesHash(t.terms)));
    expect(hashes.size).toBe(4);
  });

  it('describes the goal and its rules in plain words', () => {
    const t = parseTerms({ template: 'escape', speciesId: 'chital', count: 1 }, catalog);
    const r = parseTerms({ template: 'reach', speciesId: 'chital', x: 1200, z: 300,
      rules: [{ type: 'noRun' }, { type: 'herd', maxDistanceM: 60 }, { type: 'zone', x: 1000, z: 300, radiusM: 800 }] }, catalog);
    const h = parseTerms({ template: 'hunt', speciesId: 'tiger', count: 2 }, catalog);
    if (!t.ok || !r.ok || !h.ok) throw new Error('parse failed');
    expect(describeTerms(t.terms, catalog)).toBe('Escape 1 predator attack as a chital');
    expect(describeTerms(h.terms, catalog)).toBe('Make 2 kills as a tiger');
    expect(describeTerms(r.terms, catalog)).toBe('Reach (1200, 300) alive as a chital; never run; stay within 60 m of your own kind; '
      + 'stay within 800 m of (1000, 300)');
  });
});

describe('challenge goals', () => {
  const start = { startedWorld: 1000, kills: 0, escapes: 0 };
  it('a survive goal is met only after the full number of forest days', () => {
    const terms = { template: 'survive', version: 1, speciesId: 'chital', days: 3, ...none } as const;
    expect(goalMet(terms, start, 1000 + 3 * WORLD_DAY_SECONDS - 1)).toBe(false);
    expect(goalMet(terms, start, 1000 + 3 * WORLD_DAY_SECONDS)).toBe(true);
    expect(progressOf(terms, start, 1000 + 1.5 * WORLD_DAY_SECONDS)).toEqual({ done: 1.5, of: 3, unit: 'days' });
  });
  it('a hunt goal needs its count of kills; an escape goal its count of escapes', () => {
    const hunt = { template: 'hunt', version: 1, speciesId: 'tiger', count: 2, ...none } as const;
    expect(goalMet(hunt, { ...start, kills: 1 }, 0)).toBe(false);
    expect(goalMet(hunt, { ...start, kills: 2 }, 0)).toBe(true);
    expect(progressOf(hunt, { ...start, kills: 1 }, 0)).toEqual({ done: 1, of: 2, unit: 'kills' });
    const escape = { template: 'escape', version: 1, speciesId: 'chital', count: 2, ...none } as const;
    expect(goalMet(escape, { ...start, escapes: 1 }, 0)).toBe(false);
    expect(goalMet(escape, { ...start, escapes: 2 }, 0)).toBe(true);
    expect(progressOf(escape, { ...start, escapes: 4 }, 0)).toEqual({ done: 2, of: 2, unit: 'escapes' });
  });
  it('a reach goal is met within 25 m of the target', () => {
    const reach = { template: 'reach', version: 1, speciesId: 'chital', x: 1000, z: 0, ...none } as const;
    expect(goalMet(reach, { ...start, position: { x: 1026, z: 0 } }, 0)).toBe(false);
    expect(goalMet(reach, { ...start, position: { x: 1025, z: 0 } }, 0)).toBe(true);
    expect(goalMet(reach, start, 0)).toBe(false);
    expect(progressOf(reach, { ...start, position: { x: 1000, z: 400.4 } }, 0)).toEqual({ done: 400, of: 0, unit: 'metres to go' });
  });
});
