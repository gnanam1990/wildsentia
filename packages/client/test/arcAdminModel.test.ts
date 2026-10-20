import { describe, expect, it } from 'vitest';
import { atomicOf, outcomeText, realTime, refusal, short, usdc, whoCanWin } from '../src/arcAdminModel.js';

// The operator's panel for Congo bounties paid on Arc.
describe('Arc bounty admin panel', () => {
  it('reads and writes USDC in 6-decimal units', () => {
    expect(usdc('1000000')).toBe('1 USDC');
    expect(usdc(500_000n)).toBe('0.5 USDC');
    expect(usdc('12345678')).toBe('12.345678 USDC');
    expect(usdc(null)).toBe('—');
    expect(atomicOf('1')).toBe(1_000_000n);
    expect(atomicOf(' 0.5 ')).toBe(500_000n);
    expect(atomicOf('2.000001')).toBe(2_000_001n);
    for (const bad of ['0', '-1', '1.2345678', 'abc', '', '1e3']) expect(atomicOf(bad)).toBeNull();
  });

  it('tells a world-time window in real time at the world\'s rate', () => {
    expect(realTime(1200)).toBe('about 1 min 40 s');
    expect(realTime(3 * 86_400)).toBe('about 6 h');
    expect(realTime(6 * 3600)).toBe('about 30 min');
    expect(realTime(86_400)).toBe('about 2 h');
  });

  it('says what happened to each bounty, and why one was refused', () => {
    expect(outcomeText({ status: 'active' })).toBe('Open: the prey is being hunted');
    expect(outcomeText({ status: 'paid', outcome: 'predator' })).toBe('Hunter won: paid');
    expect(outcomeText({ status: 'deciding', outcome: 'survived' })).toBe('Prey survived: paying…');
    expect(outcomeText({ status: 'voided', outcome: 'void' })).toBe('Nobody won: back to the pool');
    expect(short('0x0741af75301873120BeC5cEba3c18b78a1b89050')).toBe('0x0741…9050');
    expect(refusal('pool_too_small')).toContain('fund it');
    expect(refusal('something_else')).toBe('something_else');
    expect(refusal('protected_species')).toContain('protected');
    expect(whoCanWin({ agentId: null, wallet: null })).toContain('Wild');
    expect(whoCanWin({ agentId: 'ag_1', wallet: '0xed147ead816b28dcacbe3bf4f3d327e596ba2d74', agentName: 'Demo prey' })).toContain('Demo prey (wallet 0xed14…2d74)');
  });
});
