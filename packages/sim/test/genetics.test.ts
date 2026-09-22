import { describe, expect, it } from 'vitest';
import { TRAIT_IDS, createRng, type Traits } from '@vana/shared';
import { foundingTraits, inheritTraits } from '../src/agents/genetics.js';
import { Pedigree } from '../src/agents/pedigree.js';

const flat = (value: number): Traits =>
  Object.fromEntries(TRAIT_IDS.map((id) => [id, value])) as Traits;

describe('foundingTraits', () => {
  it('produces every trait in range', () => {
    const rng = createRng(1, 'g');
    for (let i = 0; i < 200; i++) {
      for (const value of Object.values(foundingTraits(rng))) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic for a given stream', () => {
    expect(foundingTraits(createRng(4, 'g'))).toEqual(foundingTraits(createRng(4, 'g')));
  });
});

describe('inheritTraits', () => {
  it('lands a child near the mid-parent value', () => {
    const rng = createRng(2, 'g');
    const children = Array.from({ length: 400 },
      () => inheritTraits(flat(0.2), flat(0.8), rng).boldness);
    const mean = children.reduce((a, b) => a + b, 0) / children.length;
    expect(mean).toBeGreaterThan(0.42);
    expect(mean).toBeLessThan(0.58);
  });

  it('still varies when both parents are identical', () => {
    const rng = createRng(3, 'g');
    const values = new Set(Array.from({ length: 50 },
      () => inheritTraits(flat(0.5), flat(0.5), rng).endurance));
    expect(values.size).toBeGreaterThan(40);
  });

  it('keeps every trait inside 0 to 1 even at the extremes', () => {
    const rng = createRng(5, 'g');
    for (let i = 0; i < 300; i++) {
      const child = inheritTraits(flat(1), flat(1), rng);
      for (const value of Object.values(child)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('depresses disease resistance in proportion to inbreeding', () => {
    const outbred = inheritTraits(flat(0.8), flat(0.8), createRng(6, 'g'), 0);
    const inbred = inheritTraits(flat(0.8), flat(0.8), createRng(6, 'g'), 0.25);
    expect(inbred.diseaseResistance).toBeLessThan(outbred.diseaseResistance);
    expect(inbred.diseaseResistance).toBeCloseTo(outbred.diseaseResistance * 0.75, 6);
  });

  it('leaves the other traits untouched by inbreeding', () => {
    const outbred = inheritTraits(flat(0.6), flat(0.6), createRng(7, 'g'), 0);
    const inbred = inheritTraits(flat(0.6), flat(0.6), createRng(7, 'g'), 0.5);
    expect(inbred.boldness).toBe(outbred.boldness);
  });

  it('is deterministic for the same stream and parents', () => {
    expect(inheritTraits(flat(0.3), flat(0.7), createRng(8, 'g')))
      .toEqual(inheritTraits(flat(0.3), flat(0.7), createRng(8, 'g')));
  });
});

describe('Pedigree', () => {
  const family = (): Pedigree => {
    const p = new Pedigree();
    p.record('mum', null, null);
    p.record('dad', null, null);
    p.record('otherDad', null, null);
    p.record('kidA', 'mum', 'dad');
    p.record('kidB', 'mum', 'dad');
    p.record('halfKid', 'mum', 'otherDad');
    p.record('grandkid', 'kidA', 'stranger');
    p.record('stranger', null, null);
    return p;
  };

  it('scores unrelated founders at zero', () => {
    expect(family().relatedness('mum', 'dad')).toBe(0);
  });

  it('scores full siblings at one half', () => {
    expect(family().relatedness('kidA', 'kidB')).toBeCloseTo(0.5, 6);
  });

  it('scores half siblings at one quarter', () => {
    expect(family().relatedness('kidA', 'halfKid')).toBeCloseTo(0.25, 6);
  });

  it('scores parent and offspring at one half', () => {
    expect(family().relatedness('mum', 'kidA')).toBeCloseTo(0.5, 6);
  });

  it('scores grandparent and grandchild at one quarter', () => {
    expect(family().relatedness('mum', 'grandkid')).toBeCloseTo(0.25, 6);
  });

  it('halves relatedness to give the offspring coefficient', () => {
    expect(family().coefficientFor('kidA', 'kidB')).toBeCloseTo(0.25, 6);
  });

  it('terminates on a corrupted cyclic pedigree instead of hanging', () => {
    const p = new Pedigree();
    p.record('a', 'b', null);
    p.record('b', 'a', null);
    expect(() => p.relatedness('a', 'b')).not.toThrow();
  });

  it('round-trips through JSON so a lineage survives a snapshot', () => {
    const original = family();
    const restored = Pedigree.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));
    expect(restored.relatedness('kidA', 'kidB')).toBeCloseTo(0.5, 6);
    expect(restored.size()).toBe(original.size());
  });
});
