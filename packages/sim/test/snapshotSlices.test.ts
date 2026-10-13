import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/world.js';
import { islandPopulation, FOREST_POPULATION, FOREST_FLOOR } from '../src/forest.js';
import { takeSnapshot, takeSnapshotSlices, snapshotJson } from '../src/snapshot.js';
import { SPECIES_DIR } from './helpers.js';

const drain = <T>(g: Generator<void, T>): { value: T; yields: number } => {
  let yields = 0;
  for (;;) { const r = g.next(); if (r.done) return { value: r.value, yields }; yields++; }
};

describe('a checkpoint in slices', () => {
  it.each([
    ['island', () => createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} })],
    ['mainland', () => createWorld({ seed: 9, speciesDir: SPECIES_DIR, initialAgents: FOREST_POPULATION, minPopulation: FOREST_FLOOR })],
    ['congo', () => createWorld({ seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1', initialAgents: { hare: 3_000, leopard: 10 }, minPopulation: {} })],
  ] as const)('%s: the sliced snapshot is the snapshot, and its JSON is byte-identical', (_name, make) => {
    const world = make(); world.step(3);
    const whole = takeSnapshot(world);
    const sliced = drain(takeSnapshotSlices(world));
    expect(sliced.yields).toBeGreaterThan(0);
    expect(sliced.value).toEqual(whole);
    expect([...snapshotJson(sliced.value)].join('')).toBe(JSON.stringify(whole));
  }, 120_000);

  it('never runs long between yields on the Congo stand-in world', () => {
    const world = createWorld({ seed: 7, speciesDir: SPECIES_DIR, terrainProfile: 'congo_v1',
      initialAgents: { hare: 45_000, chital: 3_000, leopard: 150 }, minPopulation: {}, retainEvents: 5_000 });
    world.step(2);
    takeSnapshot(world); // warm
    const gaps: number[] = [];
    let at = performance.now();
    const g = takeSnapshotSlices(world);
    for (let r = g.next(); !r.done; r = g.next()) { const now = performance.now(); gaps.push(now - at); at = now; }
    const whole = takeSnapshot(world);
    const jsonGaps: number[] = [];
    at = performance.now();
    for (const _ of snapshotJson(whole)) { const now = performance.now(); jsonGaps.push(now - at); at = now; }
    const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)]!;
    console.log(`congo checkpoint slices: clone p99 ${p99(gaps).toFixed(1)} / max ${Math.max(...gaps).toFixed(1)} ms, json p99 ${p99(jsonGaps).toFixed(1)} / max ${Math.max(...jsonGaps).toFixed(1)} ms`);
    // A garbage-collection pause can land in any slice; the slicing itself is held to 60 ms.
    expect(p99(gaps)).toBeLessThan(Number(process.env.VANA_CONGO_SLICE_MAX_MS ?? 60));
    expect(p99(jsonGaps)).toBeLessThan(Number(process.env.VANA_CONGO_SLICE_MAX_MS ?? 60));
    expect(Math.max(...gaps, ...jsonGaps)).toBeLessThan(250);
  }, 300_000);
});
