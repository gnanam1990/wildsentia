import { describe, expect, it } from 'vitest';
import { leagueOptionLabel, worldWords } from '../src/experienceWorld.js';

// The experiences page follows the server's world: in the Congo forest it speaks of the forest
// and offers the Congo's own animals, never the island's.
describe('the experiences page in its world', () => {
  it('speaks of the Congo forest, not an island, and keeps the island\'s words on the island', () => {
    const congo = Object.values(worldWords('congo')).join(' ');
    expect(congo).not.toMatch(/island|tiger|elephant|chital/i);
    expect(congo).toMatch(/forest/);
    expect(worldWords('island').eyebrow).toBe('One island. A thousand stories.');
  });
  it('names each league animal, marking the hunters', () => {
    expect(leagueOptionLabel({ id: 'african_leopard', hunts: true })).toBe('African leopard');
    expect(leagueOptionLabel({ id: 'red_river_hog', hunts: false })).toBe('Red river hog');
    expect(leagueOptionLabel({ id: 'tiger', hunts: true })).toBe('Tiger');
  });
});
