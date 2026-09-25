import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createWorld } from '@vana/sim';
import type { LiveEncounterFrame } from '@vana/shared';
import { CommunityPlayback } from '../src/communityPlayback.js';
import { HumanLayer } from '../src/humans.js';

const fixture = () => {
  const w = createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)), initialAgents: {}, minPopulation: {}, communityProfile: 'household_v1' });
  w.step(1);
  const frame: LiveEncounterFrame = { id: 'stream:3600', startWorldTime: 0, endWorldTime: 3600, rate: 12, elapsedWorldSeconds: 0, encounters: [] };
  return { c: w.community!, frame };
};
describe('checkpointed human playback clock', () => {
  it('shares the committed frame clock, catches up after preparation and never rewinds on duplicate broadcasts', () => {
    const { c, frame } = fixture(), player = new CommunityPlayback(); player.apply(c, frame, 1000);
    expect(player.elapsed(2000)).toBe(12); expect(player.poses(2000, false).size).toBe(4);
    player.apply(c, { ...frame, elapsedWorldSeconds: 1 }, 2000); expect(player.elapsed(2000)).toBe(12);
    const before = player.poses(3000, false); player.apply(c, { ...frame, elapsedWorldSeconds: 2 }, 3000);
    expect(player.poses(3000, false)).toEqual(before);
    expect(player.poses(400_000, false).size).toBe(0); // No future extrapolation.
    expect(player.poses(2000, true).size).toBe(0); // Reduced motion uses the final checkpoint.
    player.apply(c, { ...frame, id: 'new-process:3600' }, 4000); expect(player.elapsed(4000)).toBe(0);
  });
  it('requires matching durable community/frame boundaries and clears on restart or recording expiry', () => {
    const { c, frame } = fixture(), player = new CommunityPlayback(); player.apply(c, frame, 0);
    expect(player.active(0, false)).toBe(true); player.apply(c, null, 100); expect(player.poses(100, false).size).toBe(0);
    player.apply(c, { ...frame, startWorldTime: 3600, endWorldTime: 7200 }, 100); expect(player.active(100, false)).toBe(false);
    const old = structuredClone(c); delete old.motion; player.apply(old, frame, 100); expect(player.active(100, false)).toBe(false);
    player.apply(c, frame, 100); player.apply(null, frame, 200); expect(player.active(200, false)).toBe(false);
  });
  it('moves marker fallback along the actual historical route, then returns exactly to saved positions without changing the checkpoint', () => {
    const { c, frame } = fixture(), before = JSON.stringify(c), player = new CommunityPlayback(); player.apply(c, frame, 0);
    const people = c.people, layer = new HumanLayer(async () => { throw new Error('offline'); }); layer.sync(people, () => 4);
    const poses = player.poses(1000, false); layer.update(.1, new THREE.Vector3(10_000, 10_000, 10_000), 'smooth', false, true, poses);
    const markers = layer.root.getObjectByName('saved-person-location-markers') as THREE.Points;
    const position = markers.geometry.getAttribute('position');
    expect(position.getX(0)).toBeCloseTo(poses.get(people[0]!.id)!.position.x, 3);
    expect(position.getZ(0)).toBeCloseTo(poses.get(people[0]!.id)!.position.z, 3);
    layer.update(.1, new THREE.Vector3(), 'smooth', true, true, poses);
    expect(position.getX(0)).toBeCloseTo(people[0]!.position.x, 3);
    expect(position.getZ(0)).toBeCloseTo(people[0]!.position.z, 3);
    expect(JSON.stringify(c)).toBe(before); layer.dispose();
  });
});
