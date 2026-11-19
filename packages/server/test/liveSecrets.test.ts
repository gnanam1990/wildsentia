import { describe, expect, it } from 'vitest';
import { bountyAdminToken, liveNetworkSecret } from '../src/live/runtime.js';

// Audit 17 November, hardening: the network hashes' key is its own secret, and every admin token is long.
describe('live secrets', () => {
  it('keys the network hashes with VANA_LIVE_SECRET alone, never an admin token', () => {
    const secret = 'a'.repeat(64);
    expect(liveNetworkSecret({ VANA_LIVE_SECRET: ` ${secret} `, VANA_REWARDS_ADMIN_TOKEN: 'b'.repeat(64) })).toBe(secret);
    // Unset, a fresh one each boot: nothing shared with the rewards token.
    const drawn = liveNetworkSecret({ VANA_REWARDS_ADMIN_TOKEN: 'b'.repeat(64) });
    expect(drawn).toMatch(/^[0-9a-f]{64}$/);
    expect(liveNetworkSecret({})).not.toBe(drawn);
    expect(() => liveNetworkSecret({ VANA_LIVE_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('refuses a guessable simulated-bounty admin token', () => {
    expect(bountyAdminToken({})).toBeNull();
    expect(bountyAdminToken({ VANA_BOUNTY_ADMIN_TOKEN: '  ' })).toBeNull();
    expect(bountyAdminToken({ VANA_BOUNTY_ADMIN_TOKEN: 'c'.repeat(32) })).toBe('c'.repeat(32));
    for (const bad of ['admin', 'c'.repeat(31), `${'c'.repeat(20)} ${'c'.repeat(20)}`, 'c'.repeat(257)])
      expect(() => bountyAdminToken({ VANA_BOUNTY_ADMIN_TOKEN: bad })).toThrow(/VANA_BOUNTY_ADMIN_TOKEN/);
  });
});
