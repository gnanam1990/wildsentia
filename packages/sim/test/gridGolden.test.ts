import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/world.js';
import { islandPopulation } from '../src/forest.js';
import { SPECIES_DIR } from './helpers.js';

/**
 * Fingerprints of the island and mainland worlds, recorded before the grid became a value
 * (Congo plan 1A). Any change to how these worlds behave changes a hash.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/gridGolden.json', import.meta.url));

function fingerprint(world: World): string {
  const hash = createHash('sha256');
  for (const e of world.log.all()) hash.update(`${e.id}|${e.type}|${e.worldTime}|${e.patchId}|${e.actors.join(',')}\n`);
  for (const a of world.agents) hash.update(`${a.id}|${a.patchId}|${a.position?.x}|${a.position?.z}|${a.alive}\n`);
  for (const p of world.patches) hash.update(`${p.id}|${p.habitat}|${p.waterVolume}|${p.plant.grass}\n`);
  return hash.digest('hex');
}

const CASES = {
  mainland: () => createWorld({ seed: 1234, speciesDir: SPECIES_DIR, initialAgents: { sambar: 25, tiger: 2, chital: 60 }, minPopulation: { sambar: 5 } }),
  island_v1: () => createWorld({ seed: 2, speciesDir: SPECIES_DIR, terrainProfile: 'island_v1', initialAgents: islandPopulation('island_v1'), minPopulation: {} }),
  island_v2: () => createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} }),
} as const;

describe('grid refactor golden worlds', () => {
  it.each(Object.keys(CASES))('%s replays exactly as before the grid became a value', (name) => {
    const world = CASES[name as keyof typeof CASES]();
    world.step(72);
    const actual = fingerprint(world);
    if (process.env.VANA_RECORD_GOLDEN === '1') {
      const all = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string> : {};
      writeFileSync(FIXTURE, JSON.stringify({ ...all, [name]: actual }, null, 2) + '\n');
    }
    expect(actual).toBe((JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>)[name]);
  }, 120_000);
});
