import { describe, expect, it } from 'vitest';
import { leagueChoices } from '@vana/shared';

describe('league choices', () => {
  it('offers each world its own animals, with the hunters marked', () => {
    expect(leagueChoices('congo')).toEqual([
      { id: 'african_leopard', hunts: true }, { id: 'african_golden_cat', hunts: true },
      { id: 'blue_duiker', hunts: false }, { id: 'red_river_hog', hunts: false },
    ]);
    expect(leagueChoices('island').map((c) => c.id)).toEqual(['tiger', 'leopard', 'chital', 'hare']);
  });
});
