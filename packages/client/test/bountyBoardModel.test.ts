import { describe, expect, it } from 'vitest';
import { realTimeLeft, resultLines, shareUrl, wantedLine } from '../src/bountyBoardModel.js';

// The public bounty board: a live bounty never names its animal; a decided one says what happened.
describe('bounty board', () => {
  const base = { bountyId: '0xab', status: 'active', speciesId: 'blue_duiker', region: 'r2_0', amountAtomic: '1500000', timeLeftWorldSeconds: 3600, publishTxUrl: null };

  it('tells a live bounty by its amount and species, and its time left in real time', () => {
    expect(wantedLine(base)).toBe('1.5 USDC on a blue duiker');
    expect(realTimeLeft(3 * 86_400, 12)).toBe('about 6 h');
    expect(realTimeLeft(3600, 12)).toBe('about 5 min');
    expect(realTimeLeft(10, 12)).toBe('about 1 min');
    expect(realTimeLeft(0, 12)).toBe('ending');
    expect(realTimeLeft(86_400 + 1800, 12)).toBe('about 2 h 3 min');
  });

  it('says who won a decided bounty, or that it went back to the pool', () => {
    expect(resultLines({ ...base, status: 'paid', outcome: 'predator', targetAnimalId: 'blue_duiker_2011', winnerAnimalId: 'african_leopard_8e3f',
      payeeWallet: '0xfe87c08d270f8f99eb3c0050243d621d43c23e09' })).toEqual({ headline: 'Hunter won 1.5 USDC',
      detail: 'An agent\'s african leopard caught blue_duiker_2011; paid to 0xfe87…3e09.' });
    expect(resultLines({ ...base, status: 'paid', outcome: 'survived', targetAnimalId: 'blue_duiker_2011', payeeWallet: '0xed147ead816b28dcacbe3bf4f3d327e596ba2d74' }).headline)
      .toBe('Prey survived: 1.5 USDC');
    expect(resultLines({ ...base, status: 'voided', outcome: 'void', targetAnimalId: 'blue_duiker_0207' }).detail).toContain('went back to the pool');
  });

  it('shares a bounty by the server page that carries its card', () => {
    expect(shareUrl('https://wildsentia.lol/', '0xab')).toBe('https://wildsentia.lol/api/share/bounty/0xab');
  });
});
