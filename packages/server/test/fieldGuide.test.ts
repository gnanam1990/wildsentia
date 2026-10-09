import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@vana/sim';
import { fieldGuide } from '../src/live/fieldGuide.js';

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const all = [...createWorld({ seed: 1, speciesDir, terrainProfile: 'island_v1', initialAgents: {}, minPopulation: {} }).species.values()];
const guide = (id: string) => fieldGuide(all.find((s) => s.id === id)!, all);
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();

describe('field guide', () => {
  it('gives a hunter its prey, its kill rate and how close it charges from, from the island\'s own numbers', () => {
    const tiger = guide('tiger');
    expect(tiger).toMatchObject({ id: 'tiger', displayName: 'Tiger', kind: 'solitary hunter', climbsTrees: false, flies: false,
      eats: ['meat'], hunting: { killRate: 0.53, chargesFromM: 25, concealment: 0.72 }, huntedBy: [],
      social: { structure: 'solitary', isHerd: false } });
    expect(ids(tiger.hunts)).toEqual(['boar', 'chital', 'gaur', 'jackal', 'langur', 'sambar']);
    expect(tiger.hunts.find((h) => h.id === 'chital')!.displayName).toBe('Chital deer');
  });

  it('tells prey who hunts it, how early it notices and flees, and that it lives in a herd', () => {
    const chital = guide('chital');
    expect(chital).toMatchObject({ kind: 'grazer', hunting: null, hunts: [], escape: { noticesThreatsAtM: 110, fleesAtM: 55 },
      speedsMs: { walk: 1.2, trot: 4.5, run: 12.5 }, runSeconds: 40, waterLitresPerDay: 6, eats: ['grass', 'browse'],
      social: { structure: 'herd', groupSize: [6, 25], warnsOthers: true, isHerd: true } });
    expect(ids(chital.huntedBy)).toEqual(expect.arrayContaining(['dhole', 'leopard', 'tiger']));
    // Terrain from easiest to hardest.
    expect(chital.terrain[0]).toEqual({ habitat: expect.any(String), cost: 1 });
    expect(chital.terrain.map((t) => t.cost)).toEqual([...chital.terrain.map((t) => t.cost)].sort((a, b) => a - b));
  });

  it('notes climbers, flyers and who a species keeps away from', () => {
    expect(guide('leopard')).toMatchObject({ climbsTrees: true, avoids: [{ id: 'tiger', displayName: 'Tiger' }] });
    expect(guide('vulture')).toMatchObject({ flies: true, kind: 'scavenging bird', scavenges: true });
    expect(guide('dhole').social).toMatchObject({ structure: 'pack', isHerd: true });
    expect(guide('jackal').social.isHerd).toBe(false);
  });

  it('carries facts only: no persona, no instructions', () => {
    const text = JSON.stringify(all.map((s) => fieldGuide(s, all)));
    expect(text).not.toMatch(/\byou (are|should|must)\b|persona|personality/i);
  });
});
