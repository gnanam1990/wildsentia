import { describe, expect, it } from 'vitest';
import { createRng } from '@vana/shared';
import { resolveHunt, type HuntInput } from '../src/agents/predation.js';

const typical: HuntInput = {
  baseSuccess: 0.46,
  stalkConcealment: 0.72,
  canopyCover: 0.5,
  predatorStamina: 0.9,
  predatorCondition: 0.9,
  preyEvasiveness: 0.62,
  preyCondition: 0.9,
  preyAlert: false,
  herdSize: 4,
  distanceAtCommitM: 20,
  commitDistanceM: 25,
};

const rate = (input: HuntInput, seed = 1, samples = 4000): number => {
  const rng = createRng(seed, 'hunt');
  let kills = 0;
  for (let i = 0; i < samples; i++) if (resolveHunt(input, rng).killed) kills++;
  return kills / samples;
};

describe('resolveHunt', () => {
  it('is deterministic for a given rng stream', () => {
    expect(resolveHunt(typical, createRng(5, 'h'))).toEqual(resolveHunt(typical, createRng(5, 'h')));
  });

  it('keeps a typical encounter inside the plausible 20-35% band', () => {
    const success = rate(typical);
    expect(success).toBeGreaterThan(0.2);
    expect(success).toBeLessThan(0.35);
  });

  it('is far less successful against alert prey', () => {
    expect(rate({ ...typical, preyAlert: true })).toBeLessThan(rate(typical));
  });

  it('is more successful with cover than in the open', () => {
    expect(rate({ ...typical, canopyCover: 0.9 })).toBeGreaterThan(rate({ ...typical, canopyCover: 0.05 }));
  });

  it('is less successful against a larger herd', () => {
    expect(rate({ ...typical, herdSize: 25 })).toBeLessThan(rate({ ...typical, herdSize: 2 }));
  });

  it('nearly always fails when the predator is exhausted', () => {
    expect(rate({ ...typical, predatorStamina: 0.05 })).toBeLessThan(0.05);
  });

  it('is more successful against prey in poor condition', () => {
    expect(rate({ ...typical, preyCondition: 0.2 })).toBeGreaterThan(rate({ ...typical, preyCondition: 1 }));
  });

  it('fails outright when the commit happens too far out', () => {
    const far = resolveHunt({ ...typical, distanceAtCommitM: 400 }, createRng(1, 'h'));
    expect(far.killed).toBe(false);
    expect(far.stage).toBe('out_of_range');
  });

  it('reports the stage it reached, so a failure can be narrated honestly', () => {
    const stages = new Set<string>();
    const rng = createRng(3, 'h');
    for (let i = 0; i < 400; i++) stages.add(resolveHunt(typical, rng).stage);
    expect(stages.size).toBeGreaterThan(1);
    for (const stage of stages) {
      expect(['detected', 'prey_alerted', 'chase_abandoned', 'escaped', 'killed', 'out_of_range'])
        .toContain(stage);
    }
  });

  it('never returns a stamina cost above the configured maximum', () => {
    const rng = createRng(9, 'h');
    for (let i = 0; i < 200; i++) {
      const outcome = resolveHunt(typical, rng);
      expect(outcome.staminaSpent).toBeGreaterThanOrEqual(0);
      expect(outcome.staminaSpent).toBeLessThanOrEqual(1);
    }
  });
});
