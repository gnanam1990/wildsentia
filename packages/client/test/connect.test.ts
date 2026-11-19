import { describe, expect, it } from 'vitest';
import { commands, connectCopy, islandTime, lifeLength, rulesText, shortUsdc } from '../src/connect.js';
import { friendlyWorldTime } from '../src/hud.js';

describe('Connect page', () => {
  it('writes every command for this server, with the Claude player starting as a dry run', () => {
    const c = commands('https://vana.example/api');
    expect(c.get![0]).toBe('curl -O https://vana.example/api/agents/client.mjs');
    expect(c.register).toContain('export WILDSENTIA_URL=https://vana.example/api');
    expect(c.llm!.join('\n')).toMatch(/--dry-run[\s\S]*VANA_LLM_TOKEN_BUDGET/);
    expect(c.wallet!.join('\n')).toContain('wallet-message');
  });

  it('states the drop rules from the server’s own numbers', () => {
    const rules = rulesText({ audience: 'vana:w', slots: 500, registered: 3, playing: 1, clientScript: { path: '', sha256: '' },
      world: { formatted: '', season: '' }, rules: { openRadiusM: 2, openSeconds: 5, spotRadiusM: 10, idleReleaseMinutes: 15,
        possessMinutesBeforeOpening: 5, claimCooldownMinutes: 10 } });
    expect(rules.join(' ')).toMatch(/within 10 m.*within 2 m and open it for 5 seconds.*5 minutes with your animal.*last 10 minutes.*idle for 15 minutes/);
  });

  it('writes life lengths and USDC amounts for people', () => {
    expect([lifeLength(42), lifeLength(12 * 60 + 5), lifeLength(3 * 3600 + 20 * 60), lifeLength(3 * 86_400 + 5 * 3600)])
      .toEqual(['42 s', '12 min', '3 h 20 min', '3 days 5 h']);
    expect([shortUsdc('2.500000'), shortUsdc('10.000000'), shortUsdc('0.000001')]).toEqual(['2.5', '10', '0.000001']);
  });

  it('tells the island time the way the forest page does, not as the raw server label', () => {
    const t = 3 * 3600;
    expect(islandTime({ worldTime: t, formatted: 'Y01-monsoon-D01 03:00', season: 'monsoon' })).toBe('Year 1 · Day 1 · 3 am');
    expect(islandTime({ worldTime: t, formatted: 'x', season: 'monsoon' })).toBe(friendlyWorldTime(t));
    // An older server without worldTime still says something.
    expect(islandTime({ formatted: 'Y01-monsoon-D01 03:00', season: 'monsoon' })).toBe('Y01-monsoon-D01 03:00');
  });

  it('in the Congo forest, suggests its own animals and speaks of the forest', () => {
    const c = commands('https://vana.example/api', true);
    const all = Object.values(c).flat().join('\n');
    expect(all).toContain('possess blue_duiker');
    expect(all).toContain('llm.mjs blue_duiker');
    expect(all).not.toMatch(/chital|sambar|tiger|dhole/);
    const copy = Object.values(connectCopy(true)).join(' ');
    expect(copy).not.toMatch(/island|chital|tiger/i);
    expect(copy).toMatch(/African leopard/);
    expect(connectCopy(false).intro).toMatch(/island/);
    expect(commands('https://vana.example/api').play!.join('\n')).toContain('possess chital');
  });
});
