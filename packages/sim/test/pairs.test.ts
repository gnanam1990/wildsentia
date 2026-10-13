import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld, pairMateFor, type World } from '../src/world.js';
import { loadSpeciesDir } from '../src/config/loader.js';
import { makeAgent } from './helpers.js';
import { islandPopulation } from '../src/forest.js';
import { SPECIES_DIR } from './helpers.js';

const CONGO_DIR = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const duikers = () => createWorld({ seed: 11, speciesDir: CONGO_DIR, terrainProfile: 'congo_v1', initialAgents: { blue_duiker: 60 }, minPopulation: {} });
const pairsOf = (world: World) => {
  const groups = new Map<string, string[]>();
  for (const a of world.agents) if (a.groupId) groups.set(a.groupId, [...(groups.get(a.groupId) ?? []), a.id]);
  return [...groups.values()];
};

describe('blue duikers live in pairs (1B)', () => {
  it('are founded as male-female pairs in one place', () => {
    const world = duikers(), groups = pairsOf(world);
    const pairs = groups.filter((g) => g.length === 2);
    expect(pairs.length).toBeGreaterThanOrEqual(20);
    expect(groups.every((g) => g.length <= 2)).toBe(true);
    for (const [a, b] of pairs) {
      const x = world.animal(a!)!, y = world.animal(b!)!;
      expect(x.sex).not.toBe(y.sex);
      expect(x.patchId).toBe(y.patchId);
    }
  }, 120_000);

  it('keep together: after ten days most pairs are still within a patch of each other', () => {
    const world = duikers();
    world.step(240);
    const pairs = pairsOf(world).filter((g) => g.length === 2 && g.every((id) => world.animal(id)?.alive));
    const close = pairs.filter(([a, b]) => {
      const x = world.patches[world.animal(a!)!.patchId]!, y = world.patches[world.animal(b!)!.patchId]!;
      return Math.abs(x.x - y.x) + Math.abs(x.y - y.y) <= 1;
    });
    expect(close.length / pairs.length).toBeGreaterThan(0.8);
  }, 300_000);

  it('court only their pair-mate while it lives', () => {
    const world = duikers();
    world.step(24 * 45); // founders are adults; oestrus comes every 21 days
    let paired = 0;
    for (const e of world.log.all().filter((e) => e.type === 'courtship' && e.actors.length === 2)) {
      const [f, m] = e.actors.map((id) => world.animal(id));
      if (!f || !m || !f.groupId) continue;
      const mate = world.agents.find((a) => a.groupId === f.groupId && a.id !== f.id && a.sex !== f.sex);
      if (!mate) continue;
      paired++;
      expect(m.id).toBe(mate.id);
    }
    expect(paired).toBeGreaterThan(0);
  }, 300_000);

  it('name the pair-mate, and none for a widow or the unpaired', () => {
    const cfg = loadSpeciesDir(CONGO_DIR).get('blue_duiker')!;
    const f = { ...makeAgent('chital', { id: 'f', sex: 'female' }), speciesId: 'blue_duiker', groupId: 'g1' };
    const mate = { ...makeAgent('chital', { id: 'm1', sex: 'male' }), speciesId: 'blue_duiker', groupId: 'g1' };
    const rival = { ...makeAgent('chital', { id: 'm2', sex: 'male' }), speciesId: 'blue_duiker', groupId: 'g2' };
    expect(pairMateFor(f, cfg, [f, mate, rival])?.id).toBe('m1');
    expect(pairMateFor(f, cfg, [f, { ...mate, alive: false }, rival])).toBeNull();
    expect(pairMateFor({ ...f, groupId: null }, cfg, [f, mate, rival])).toBeNull();
    const chitalCfg = { ...cfg, social: { ...cfg.social, pairBond: false } };
    expect(pairMateFor(f, chitalCfg, [f, mate])).toBeNull();
  });

  it('never name kin as the pair-mate: a grown daughter is not her fathers mate, a widow not her sons (1B review)', () => {
    const cfg = loadSpeciesDir(CONGO_DIR).get('blue_duiker')!;
    const mk = (id: string, sex: 'female' | 'male', lifeStage = 'adult' as const) => ({ ...makeAgent('chital', { id, sex, lifeStage }), speciesId: 'blue_duiker', groupId: 'g1' });
    const daughter = mk('d', 'female'), father = mk('f', 'male'), mother = mk('m', 'female'), son = mk('s', 'male', 'subadult');
    const kin = (a: { id: string }, b: { id: string }) => new Set(['d|f', 'f|d', 'm|s', 's|m']).has(`${a.id}|${b.id}`);
    expect(pairMateFor(daughter, cfg, [daughter, father, mother], kin)).toBeNull();
    expect(pairMateFor(mother, cfg, [mother, son], kin)).toBeNull();
    expect(pairMateFor(mother, cfg, [mother, father, son], kin)?.id).toBe('f');
  });

  it('leave island species ungrouped as before', () => {
    const island = createWorld({ seed: 3, speciesDir: SPECIES_DIR, terrainProfile: 'island_v2', initialAgents: islandPopulation('island_v2'), minPopulation: {} });
    expect(island.agents.filter((a) => island.species.get(a.speciesId)!.social.structure === 'solitary').every((a) => a.groupId == null)).toBe(true);
  });
});
