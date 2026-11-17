import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FollowCamera } from '../src/camera.js';
import { CURTAIN_MAX_MS, TravelCurtain } from '../src/travelCurtain.js';

function surface() {
  return Object.assign(new EventTarget(), { setPointerCapture: () => undefined }) as unknown as HTMLElement;
}

describe('choosing another animal', () => {
  it('cuts the camera straight to it, at its framing distance, instead of gliding across the forest', () => {
    const follow = new FollowCamera(new THREE.PerspectiveCamera(50, 1, .1, 5000), surface());
    follow.groundHeightAt = () => 0;
    follow.follow({ x: 0, z: 0, heading: 0, moving: false }, 1 / 60);
    follow.flyToDistance(9);
    follow.cutToNext();
    expect(follow.cutPending).toBe(true);
    follow.follow({ x: 13_000, z: -4_000, heading: 0, moving: false }, 1 / 60);
    expect(follow.cutPending).toBe(false);
    expect(follow.target.x).toBeCloseTo(13_000);
    expect(follow.target.z).toBeCloseTo(-4_000);
    expect(follow.distance).toBe(9);
    // Afterwards it follows smoothly again.
    follow.follow({ x: 13_010, z: -4_000, heading: 0, moving: true }, 1 / 60);
    expect(follow.target.x).toBeLessThan(13_010);
  });
});

describe('travel curtain', () => {
  it('waits for the destination region, then lifts two frames after it is built', () => {
    let now = 0;
    const curtain = new TravelCurtain(null, () => now);
    curtain.show('Finding the forest buffalo…', 42);
    curtain.drawn(); curtain.frameDrawn(); curtain.frameDrawn();
    expect(curtain.showing).toBe(true);
    curtain.sceneBuilt((patch) => patch === 7);
    curtain.frameDrawn(); curtain.frameDrawn();
    expect(curtain.showing).toBe(true);
    curtain.sceneBuilt((patch) => patch === 42);
    curtain.frameDrawn(); expect(curtain.showing).toBe(true);
    curtain.frameDrawn(); expect(curtain.showing).toBe(false);
  });

  it('lifts on the next scene for a cut into another loaded region, or soon when none comes', () => {
    let now = 0;
    const curtain = new TravelCurtain(null, () => now);
    curtain.show('Finding the leopard…', null, true, 1_500);
    curtain.drawn(); curtain.frameDrawn(); curtain.frameDrawn();
    expect(curtain.showing).toBe(true);
    now = 1_501; curtain.frameDrawn();
    expect(curtain.showing).toBe(false);
    curtain.show('Finding the leopard…', null, true, 1_500);
    curtain.sceneBuilt(() => false); curtain.frameDrawn(); curtain.frameDrawn();
    expect(curtain.showing).toBe(false);
  });

  it('lifts once a far animal found by asking is drawn, and never stays up for long', () => {
    let now = 0;
    const curtain = new TravelCurtain(null, () => now);
    curtain.show('Finding the eagle…');
    curtain.drawn(); curtain.frameDrawn(); curtain.frameDrawn();
    expect(curtain.showing).toBe(false);
    curtain.show('Finding the eagle…', 3);
    now = CURTAIN_MAX_MS + 1; curtain.frameDrawn();
    expect(curtain.showing).toBe(false);
  });
});
