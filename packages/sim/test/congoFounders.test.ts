import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORLD_SECONDS_PER_DAY } from '@vana/shared';
import { createWorld } from '../src/world.js';
import { restoreSnapshot, takeSnapshot } from '../src/snapshot.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const D = WORLD_SECONDS_PER_DAY;

// The one-year Congo soak (docs/2026-10-13-congo-measurements.md) began with every founding
// female receptive at once: the leopards bred in lockstep (92 to 179 in four months, then a
// crash) and no duiker was born before day 207, a gestation away. A wild population holds its
// females at every point of their breeding cycle; Congo founders start that way.
describe('Congo founders', () => {
  const world = createWorld({ seed: 11, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1',
    initialAgents: { blue_duiker: 600, african_leopard: 200 }, minPopulation: {} });
  const females = (id: string) => world.agents.filter((a) => a.speciesId === id && a.sex === 'female');

  it('start at every point of the breeding cycle: about a gestation\'s share of females already pregnant', () => {
    for (const [id, gestation, interval] of [['blue_duiker', 207, 265], ['african_leopard', 96, 600]] as const) {
      const all = females(id), pregnant = all.filter((a) => a.pregnantSince !== null);
      expect(pregnant.length / all.length, id).toBeGreaterThan(gestation / interval - 0.1);
      expect(pregnant.length / all.length, id).toBeLessThan(gestation / interval + 0.1);
      for (const a of pregnant) {
        expect(a.pregnantSince!).toBeLessThanOrEqual(0);
        expect(a.pregnantSince!).toBeGreaterThan(-gestation * D);
        expect(a.pregnancyFatherId).toBeNull();
      }
      // The rest come into breeding over what remains of their interval, not all at once.
      const waiting = all.filter((a) => a.pregnantSince === null).map((a) => a.nextOestrusAt ?? 0);
      expect(Math.max(...waiting)).toBeLessThanOrEqual((interval - gestation) * D);
      expect(Math.min(...waiting)).toBeGreaterThanOrEqual(0);
      expect(new Set(waiting.map((t) => Math.floor(t / (30 * D)))).size).toBeGreaterThan(1);
    }
  });

  it('gives birth from the first weeks, spread over a gestation, never at once', () => {
    const due = (id: string, gestation: number) => females(id).filter((a) => a.pregnantSince !== null)
      .map((a) => (a.pregnantSince! + gestation * D) / D);
    const duikerDue = due('blue_duiker', 207);
    expect(duikerDue.filter((d) => d <= 30).length).toBeGreaterThan(0);
    expect(Math.max(...duikerDue) - Math.min(...duikerDue)).toBeGreaterThan(150);
  });

  it('gives a founder\'s young their own traits, from her and a sire from before the record', () => {
    const w = createWorld({ seed: 11, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1',
      initialAgents: { blue_duiker: 600, african_leopard: 30 }, minPopulation: {} });
    w.step(96);
    const young = w.agents.filter((a) => a.generation === 1 && a.fatherId === null);
    expect(young.length).toBeGreaterThan(0);
    for (const child of young) {
      const mother = w.agents.find((a) => a.id === child.motherId)!;
      expect(child.traits).not.toBe(mother.traits);
      expect(child.traits).not.toEqual(mother.traits);
    }
  }, 120_000);
  it('keeps the founders\' breeding state through a snapshot', () => {
    const restored = restoreSnapshot(takeSnapshot(world), { seed: 11, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1', initialAgents: {}, minPopulation: {} });
    expect(restored.agents.filter((a) => a.pregnantSince !== null).length).toBe(world.agents.filter((a) => a.pregnantSince !== null).length);
  });
});
