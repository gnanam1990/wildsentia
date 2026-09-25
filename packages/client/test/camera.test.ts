import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FollowCamera, followDistanceFor, terrainSafeCameraHeight } from '../src/camera.js';
import { renderBaseY } from '../src/space.js';

function surface() {
  return Object.assign(new EventTarget(), { setPointerCapture: () => undefined }) as unknown as HTMLElement;
}
function dispatch(target: HTMLElement, name: string, values: Record<string, unknown>) {
  const event = Object.assign(new Event(name, { cancelable: true }), values);
  target.dispatchEvent(event);
  return event;
}

describe('observer camera input', () => {
  it('frames adult elephants nearer without changing other species framing', () => {
    expect(followDistanceFor('elephant', 2.7)).toBe(13.5);
    expect(followDistanceFor('chital', .9)).toBe(8.1);
    expect(followDistanceFor('hare', .22)).toBe(2.5);
  });
  it('frames a recorded airborne subject and returns to ground on landing', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, .1, 1000), follow = new FollowCamera(camera, surface());
    follow.groundHeightAt = () => 12; follow.reducedMotion = true;
    for (const altitudeM of [0, 8, 40, 8, 0]) {
      const pose = { x: 10, z: 20, heading: 0, moving: true, altitudeM };
      const y = renderBaseY(pose, follow.groundHeightAt);
      follow.follow({ ...pose, y, focusHeight: .4 }, 1);
      expect(follow.target.y).toBeCloseTo(12 + altitudeM + .4);
      camera.updateMatrixWorld();
      const screen = new THREE.Vector3(pose.x, y + .4, pose.z).project(camera);
      expect(screen.x).toBeCloseTo(0); expect(screen.y).toBeCloseTo(0);
    }
    expect(renderBaseY({ x: 10, z: 20 }, follow.groundHeightAt)).toBe(12);
  });
  it('does not consume browser shortcuts or auto-rotate in reduced-motion mode', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(dispatch(target, 'keydown', { key: '+', [modifier]: true }).defaultPrevented).toBe(false);
    }
    expect(follow.distance).toBe(22);
    follow.reducedMotion = true;
    follow.follow({ x: 0, z: 0, heading: 2, moving: true }, 1);
    expect(follow.theta).toBe(0.9);
  });

  it('lifts over a middle ridge even when the desired camera endpoint is clear', () => {
    const target = new THREE.Vector3(0, 1, 0), desired = new THREE.Vector3(0, 4, 20);
    const ground = (_x: number, z: number) => z >= 8 && z <= 12 ? 6 : 0;
    const height = terrainSafeCameraHeight(target, desired, ground);
    expect(height).toBeGreaterThan(12);
    for (let i = 1; i <= 64; i++) {
      const t = i / 64;
      expect(target.y + (height - target.y) * t).toBeGreaterThanOrEqual(ground(0, 20 * t));
    }
    expect(terrainSafeCameraHeight(target, desired, () => 0)).toBe(4);
    expect(terrainSafeCameraHeight(target, desired, () => NaN)).toBe(4);
    expect(target.toArray()).toEqual([0, 1, 0]); expect(desired.toArray()).toEqual([0, 4, 20]);
  });

  it('keeps the camera above terrain without changing orbit/zoom intent', () => {
    const camera = new THREE.PerspectiveCamera();
    const follow = new FollowCamera(camera, surface());
    follow.groundHeightAt = () => 10;
    follow.freeLook(1 / 60);
    expect(camera.position.y).toBeGreaterThan(10.6);
    expect(follow.target.y).toBeCloseTo(10.05);
    expect(follow.theta).toBe(0.9); expect(follow.phi).toBe(0.55); expect(follow.distance).toBe(22);
  });
  it('supports keyboard orbit and zoom without changing simulation state', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    const theta = follow.theta;
    expect(dispatch(target, 'keydown', { key: 'ArrowRight' }).defaultPrevented).toBe(true);
    expect(follow.theta).toBeGreaterThan(theta);
    dispatch(target, 'keydown', { key: '+' });
    expect(follow.distance).toBeLessThan(22);
    expect(dispatch(target, 'keydown', { key: 'Tab' }).defaultPrevented).toBe(false);
  });

  it('handles touch-style pointer drags and cancellation', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    dispatch(target, 'pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    dispatch(target, 'pointermove', { clientX: 70, clientY: 10 });
    expect(follow.theta).toBeCloseTo(0.6);
    dispatch(target, 'pointercancel', {});
    dispatch(target, 'pointermove', { clientX: 170, clientY: 10 });
    expect(follow.theta).toBeCloseTo(0.6);
  });

  it('bounds wheel zoom and focuses at the reported species height', () => {
    const target = surface();
    const camera = new THREE.PerspectiveCamera();
    const follow = new FollowCamera(camera, target);
    dispatch(target, 'wheel', { deltaY: -100000 });
    expect(follow.distance).toBe(1);
    dispatch(target, 'wheel', { deltaY: 100000 });
    expect(follow.distance).toBe(1500);
    follow.follow({ x: 0, z: 0, y: 10, focusHeight: 0.11, heading: 0, moving: false }, 1);
    expect(follow.target.y).toBeCloseTo(10.11);
  });
});
