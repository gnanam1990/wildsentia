import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AnimalDots } from '../src/animalDots.js';
import type { AnimalState } from '../src/protocol.js';
import type { RenderPosition } from '../src/space.js';
import { visualFor } from '../src/species.js';

const animal = (id: string, speciesId = 'chital'): AnimalState => ({ id, speciesId, patchId: 0,
  state: 'resting', currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } });
const point = (x: number, z = 0): RenderPosition => ({ x, z, heading: 0, moving: false });
const a = new Map([['a', animal('a')], ['b', animal('b', 'hare')], ['c', animal('c')]]);
const p = new Map([['a', point(.123456789)], ['b', point(20)], ['c', point(30)]]);
const none = new Set<string>();
const attributes = (dots: AnimalDots) => ({ pos: dots.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
  colour: dots.mesh.geometry.getAttribute('color') as THREE.BufferAttribute });

describe('incremental distant animal buffers', () => {
  it('invalidates a stationary dot when only altitude changes and clears it on landing', () => {
    const dots = new AnimalDots(2), ground = vi.fn(() => 10), poses = new Map([['a', point(0)]]);
    dots.sync(a, poses, none, ground); const { pos } = attributes(dots);
    for (const altitudeM of [5, 20, 3, 0]) {
      const prior = pos.version; poses.set('a', { ...point(0), altitudeM }); dots.sync(a, poses, none, ground);
      expect(pos.getY(0)).toBeCloseTo(10 + visualFor('chital').heightM + altitudeM);
      expect(pos.version).toBe(prior + 1);
      dots.sync(a, poses, none, ground); expect(pos.version).toBe(prior + 1);
    }
    poses.set('a', point(0)); const version = pos.version;
    dots.sync(a, poses, none, ground); expect(pos.version).toBe(version);
  });
  it('keeps exact slot inputs and avoids repeated terrain samples and buffer uploads for unchanged dots', () => {
    const dots = new AnimalDots(8000), ground = vi.fn(() => 4);
    dots.sync(a, p, none, ground);
    const { pos, colour } = attributes(dots), versions = [pos.version, colour.version];
    pos.clearUpdateRanges(); colour.clearUpdateRanges();
    for (let i = 0; i < 120; i++) dots.sync(a, p, none, ground);
    expect(ground).toHaveBeenCalledTimes(3);
    expect([pos.version, colour.version]).toEqual(versions);
    expect(pos.updateRanges).toEqual([]); expect(colour.updateRanges).toEqual([]);
    expect(pos.getX(0)).toBe(Math.fround(.123456789));
    expect(pos.getY(0)).toBeCloseTo(4 + visualFor('chital').heightM);
  });
  it('uploads the changed position only, retaining unconsumed dirty ranges across multiple syncs', () => {
    const dots = new AnimalDots(8), ground = vi.fn(() => 0), poses = new Map(p);
    dots.sync(a, poses, none, ground);
    const { pos, colour } = attributes(dots); pos.clearUpdateRanges(); colour.clearUpdateRanges();
    const colourVersion = colour.version;
    poses.set('b', point(21)); dots.sync(a, poses, none, ground);
    expect(pos.updateRanges).toEqual([{ start: 3, count: 3 }]);
    poses.set('c', point(31)); dots.sync(a, poses, none, ground);
    expect(pos.updateRanges).toEqual([{ start: 3, count: 6 }]);
    expect(pos.getX(1)).toBe(21); expect(pos.getX(2)).toBe(31);
    expect(ground).toHaveBeenCalledTimes(5); expect(colour.version).toBe(colourVersion);
    pos.clearUpdateRanges();
    for (let i = 0; i < 60; i++) { poses.set('b', point(22 + i)); dots.sync(a, poses, none, ground); }
    expect(pos.updateRanges).toEqual([{ start: 3, count: 3 }]); // bounded without any renderer acknowledgements
  });
  it('preserves correct picking/colour/height when model selection, order, identity or species changes', () => {
    const dots = new AnimalDots(8), ground = () => 2;
    dots.sync(a, p, none, ground);
    dots.sync(a, p, new Set(['a']), ground);
    expect([dots.idAt(0), dots.idAt(1), dots.idAt(2)]).toEqual(['b', 'c', undefined]);
    const { pos, colour } = attributes(dots);
    expect(pos.getX(0)).toBe(20); expect(pos.getY(0)).toBeCloseTo(2 + visualFor('hare').heightM);
    const expected = new THREE.Color(visualFor('hare').colour);
    expect(colour.getX(0)).toBeCloseTo(expected.r);
    const changed = new Map(a); changed.set('b', animal('b', 'elephant'));
    dots.sync(changed, p, new Set(['a']), ground);
    expect(pos.getY(0)).toBeCloseTo(2 + visualFor('elephant').heightM);
    const reordered = new Map([...p].reverse()); dots.sync(a, reordered, none, ground);
    expect([dots.idAt(0), dots.idAt(1), dots.idAt(2)]).toEqual(['c', 'b', 'a']);
    const replaced = new Map([['new', animal('new')]]);
    dots.sync(replaced, new Map([['new', point(30)]]), none, ground);
    expect(dots.idAt(0)).toBe('new'); expect(dots.idAt(1)).toBeUndefined();
  });
  it('invalidates heights on terrain replacement and restores dots after replay without a redundant upload', () => {
    const dots = new AnimalDots(8), old = () => 0, next = vi.fn(() => 20);
    dots.sync(a, p, none, old); dots.sync(a, p, none, next);
    expect(next).toHaveBeenCalledTimes(3);
    const { pos } = attributes(dots), version = pos.version;
    expect(pos.getY(0)).toBeCloseTo(20.9);
    dots.hide(); expect(dots.idAt(0)).toBeUndefined(); expect(dots.mesh.geometry.drawRange.count).toBe(0);
    dots.sync(a, p, none, next);
    expect(pos.version).toBe(version); expect(dots.idAt(0)).toBe('a');
    dots.sync(new Map(), new Map(), none, next);
    expect(dots.mesh.geometry.drawRange.count).toBe(0); expect(dots.idAt(0)).toBeUndefined();
    dots.sync(a, p, none, next); expect(next).toHaveBeenCalledTimes(6);
  });
  it('bounds capacity, ignores missing animal entries, and never exposes stale click IDs', () => {
    expect(() => new AnimalDots(0)).toThrow();
    const dots = new AnimalDots(2), poses = new Map([['missing', point(0)], ...p]);
    dots.sync(a, poses, none, () => 0);
    expect(dots.mesh.geometry.drawRange.count).toBe(2);
    expect(dots.idAt(2)).toBeUndefined(); expect(dots.idAt(-1)).toBeUndefined(); expect(dots.idAt(.5)).toBeUndefined();
    expect(dots.idAt(0)).toBe('a');
    dots.sync(a, poses, new Set(['a']), () => 0); expect(dots.idAt(0)).toBe('b'); expect(dots.idAt(1)).toBe('c');
  });
});
