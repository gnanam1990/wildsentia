import { describe, expect, it } from 'vitest';
import { assetState, countdown, simAmount, timeLeft } from '../src/congoModel.js';

const life = (over: Record<string, unknown> = {}) => ({ lifeId: 'l1', animalId: 'african_leopard_0001', status: 'alive', spawnedAt: '2026-10-13T10:00:00Z',
  diedAt: null, deathCause: null, killerAnimalId: null, cooldownUntil: null, controller: null, bountyActive: false, ...over });
const asset = (over: Record<string, unknown> = {}) => ({ assetId: 'a1', speciesId: 'african_leopard', status: 'active', agents: [], life: life(), ...over });

// Congo 1E: the states a person sees for each of their animals (spec §7).
describe('the Congo player pages', () => {
  it('shows each state the spec names', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(assetState(asset({ animal: { state: 'resting' } }), now).label).toBe('Resting');
    expect(assetState(asset({ animal: { state: 'chasing' } }), now).label).toBe('Hunting');
    expect(assetState(asset({ animal: { state: 'fleeing' } }), now).label).toBe('Fleeing');
    expect(assetState(asset({ animal: { state: 'grazing' } }), now).label).toBe('Alive');
    expect(assetState(asset({ life: life({ controller: { kind: 'agent', id: 'ag_1' } }), animal: { state: 'resting', steered: false } }), now).label).toBe('Disconnected');
    expect(assetState(asset({ life: life({ bountyActive: true }), animal: { state: 'resting' } }), now)).toMatchObject({ label: 'Bounty active', tone: 'warn' });
    expect(assetState(asset({ life: life({ status: 'cooldown', diedAt: '2026-10-13T11:30:00Z', cooldownUntil: '2026-10-13T13:05:00Z', deathCause: 'predation' }) }), now))
      .toMatchObject({ label: 'Cooldown', detail: 'Can respawn in 1 h 05 min · died of predation' });
    expect(assetState(asset({ life: life({ status: 'dead' }) }), now).label).toBe('Ready to respawn');
    expect(assetState(asset({ life: null }), now).label).toBe('Not yet spawned');
    expect(assetState(asset({ life: life({ status: 'dead' }), bounty: { lifeId: 'l1', outcome: 'predator', role: 'winner', payout: { status: 'intent' }, paidToOwner: true } }), now).label).toBe('Payout pending (SIMULATED)');
    expect(assetState(asset({ life: life({ status: 'dead' }), bounty: { lifeId: 'l1', outcome: 'survived', role: 'target', payout: { status: 'recorded' }, paidToOwner: true } }), now).label).toBe('Payout recorded (SIMULATED)');
    expect(assetState(asset({ life: life({ status: 'dead' }), bounty: { lifeId: 'l1', outcome: 'void', role: 'target', payout: null, paidToOwner: false } }), now).label).toBe('Outcome verified');
    // The target's owner sees the outcome, not someone else's payout.
    expect(assetState(asset({ life: life({ status: 'dead' }), bounty: { lifeId: 'l1', outcome: 'predator', role: 'target', payout: { status: 'recorded' }, paidToOwner: false } }), now))
      .toMatchObject({ label: 'Outcome verified', detail: 'Taken by a predator: the reward went to its owner' });
    // While its cooldown runs, that is what the owner sees (it cannot respawn yet), with the outcome alongside.
    expect(assetState(asset({ life: life({ status: 'cooldown', diedAt: '2026-10-13T11:50:00Z', cooldownUntil: '2026-10-13T13:50:00Z', deathCause: 'predation' }),
      bounty: { lifeId: 'l1', outcome: 'predator', role: 'target', payout: { status: 'recorded' }, paidToOwner: false } }), now))
      .toMatchObject({ label: 'Cooldown', detail: 'Can respawn in 1 h 50 min · taken by a predator: the reward went to its owner' });
  });
  it('lets the animal\'s state now lead, with a bounty of this life alongside, and forgets the bounty of an earlier life', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const won = { lifeId: 'l1', outcome: 'predator' as const, role: 'winner' as const, payout: { status: 'recorded' as const }, paidToOwner: true };
    // The winner, alive and steered by nobody now: the live state, with its payout alongside.
    expect(assetState(asset({ life: life({ controller: { kind: 'agent', id: 'ag_1' } }), animal: { state: 'resting', steered: false }, bounty: won }), now))
      .toMatchObject({ label: 'Disconnected', detail: 'Won a bounty: payout recorded (SIMULATED)' });
    // The winner, later dead and cooling down: the cooldown leads (no Respawn yet).
    expect(assetState(asset({ life: life({ status: 'cooldown', cooldownUntil: '2026-10-13T12:30:00Z' }), bounty: won }), now).label).toBe('Cooldown');
    // A respawned target: the new life is just alive; the old life's bounty is not shown.
    expect(assetState(asset({ life: life({ lifeId: 'l2' }), animal: { state: 'grazing' },
      bounty: { lifeId: 'l1', outcome: 'predator', role: 'target', payout: { status: 'recorded' }, paidToOwner: false } }), now)).toEqual({ label: 'Alive', tone: 'ok' });
  });
  it('writes amounts in exact units, always marked SIMULATED, and times left plainly', () => {
    expect(simAmount('10000000', 6, 'SIM-USDC')).toBe('10.00 SIM-USDC (SIMULATED)');
    expect(simAmount('2500001', 6, 'SIM-USDC')).toBe('2.500001 SIM-USDC (SIMULATED)');
    expect(countdown(65 * 60_000)).toBe('1 h 05 min');
    expect(countdown(30_000)).toBe('under a minute');
    expect(timeLeft(2 * 86_400 + 3 * 3600)).toBe('2 world days 3 h');
  });
});
