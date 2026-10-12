import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clampToIsland, FollowCamera, followDistanceFor, groundPan, terrainSafeCameraHeight } from '../src/camera.js';
import { nearestOnScreen } from '../src/picking.js';
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

  it('rotates on right- or shift-drag and stops on cancellation', () => {
    for (const press of [{ button: 2 }, { button: 0, shiftKey: true }]) {
      const target = surface();
      const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
      dispatch(target, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10, ...press });
      dispatch(target, 'pointermove', { pointerId: 1, clientX: 70, clientY: 10 });
      expect(follow.theta).toBeCloseTo(0.6);
      dispatch(target, 'pointercancel', { pointerId: 1 });
      dispatch(target, 'pointermove', { pointerId: 1, clientX: 170, clientY: 10 });
      expect(follow.theta).toBeCloseTo(0.6);
      expect(follow.target.toArray()).toEqual([0, 0, 0]);
    }
  });

  it('pans the island on a plain drag, keeping the dragged ground under the cursor, and lets go of the animal', () => {
    const target = surface();
    const camera = new THREE.PerspectiveCamera(50, 1, .1, 20000);
    const follow = new FollowCamera(camera, target);
    let explored = 0;
    follow.onExplore = () => { explored++; };
    follow.target.set(3000, 0, 3000); follow.distance = 400; follow.theta = 0; follow.phi = Math.PI / 2 - 1e-6;
    // A click that wobbles a pixel or two is still a click on an animal, not a pan.
    dispatch(target, 'pointerdown', { pointerId: 1, button: 0, clientX: 400, clientY: 400 });
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 402, clientY: 401 });
    expect(explored).toBe(0);
    expect(follow.target.x).toBe(3000);
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 480, clientY: 400 });
    expect(explored).toBeGreaterThan(0);
    // Looking straight down with theta 0, screen-right is world +x: dragging right moves the view west.
    const metresPerPixel = 2 * 400 * Math.tan(25 * Math.PI / 180) / 800;
    // Measured from the press point, so the ground grabbed there stays under the cursor.
    expect(follow.target.x).toBeCloseTo(3000 - 80 * metresPerPixel, 3);
    expect(follow.target.z).toBeCloseTo(3000, 3);
    dispatch(target, 'pointerup', { pointerId: 1 });
    expect(follow.wasGesture).toBe(false);
  });

  it('moves in the direction the viewer faces, at any rotation', () => {
    for (const theta of [0, 0.9, 2.5, -1.2]) {
      const move = groundPan(theta, 0.6, 100, 50, 800, 0, 100);
      // Dragging down pulls the far ground toward the viewer: the target moves away from the camera.
      const away = { x: -Math.sin(theta), z: -Math.cos(theta) };
      expect(move.x * away.x + move.z * away.z).toBeGreaterThan(0);
      const side = groundPan(theta, 0.6, 100, 50, 800, 100, 0);
      expect(side.x * away.x + side.z * away.z).toBeCloseTo(0);
    }
    // Twice as high, twice the ground per pixel.
    expect(groundPan(0, 1, 200, 50, 800, 10, 0).x).toBeCloseTo(2 * groundPan(0, 1, 100, 50, 800, 10, 0).x);
  });

  it('never explores off the island', () => {
    expect(clampToIsland(new THREE.Vector3(-99999, 4, 99999)).toArray()).toEqual([-450, 4, 6150]);
    expect(clampToIsland(new THREE.Vector3(2000, 0, 3000)).toArray()).toEqual([2000, 0, 3000]);
  });

  it('pinches to zoom and twists to rotate, and a pinch is never a tap', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    follow.distance = 100;
    dispatch(target, 'pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    dispatch(target, 'pointerdown', { pointerId: 2, button: 0, clientX: 200, clientY: 100 });
    dispatch(target, 'pointermove', { pointerId: 2, clientX: 300, clientY: 100 });
    expect(follow.distance).toBeCloseTo(50);
    const theta = follow.theta;
    dispatch(target, 'pointermove', { pointerId: 2, clientX: 100, clientY: 300 });
    expect(follow.theta).toBeCloseTo(theta - Math.PI / 2);
    dispatch(target, 'pointerup', { pointerId: 2 });
    dispatch(target, 'pointerup', { pointerId: 1 });
    expect(follow.wasGesture).toBe(true);
  });

  it('pans with W A S D while exploring and glides to a stop after a flick', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    follow.target.set(3000, 0, 3000); follow.theta = 0; follow.distance = 300;
    expect(dispatch(target, 'keydown', { key: 'w' }).defaultPrevented).toBe(true);
    follow.freeLook(0.1);
    // Facing -z with theta 0: W moves the explored point north.
    expect(follow.target.z).toBeLessThan(3000);
    dispatch(target, 'keyup', { key: 'w' });
    const z = follow.target.z;
    follow.freeLook(0.1);
    expect(follow.target.z).toBe(z);
  });

  it('bounds wheel zoom and focuses at the reported species height', () => {
    const target = surface();
    const camera = new THREE.PerspectiveCamera();
    const follow = new FollowCamera(camera, target);
    dispatch(target, 'wheel', { deltaY: -100000 });
    expect(follow.distance).toBe(1);
    dispatch(target, 'wheel', { deltaY: 100000 });
    expect(follow.distance).toBe(5000);
    follow.follow({ x: 0, z: 0, y: 10, focusHeight: 0.11, heading: 0, moving: false }, 1);
    expect(follow.target.y).toBeCloseTo(10.11);
  });
});

describe('tapping an animal', () => {
  it('picks the animal drawn nearest the tap, dot or model, within the radius', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 20000);
    camera.position.set(0, 1000, 0.001); camera.lookAt(0, 0, 0);
    const points = new Map([['hare_1', { x: 0, y: 0, z: 0 }], ['tiger_1', { x: 60, y: 0, z: 0 }], ['behind', { x: 0, y: 2000, z: 0 }]]);
    expect(nearestOnScreen(points, camera, 400, 400, 800, 800, 20)).toBe('hare_1');
    const tigerX = new THREE.Vector3(60, 0, 0).project(camera).x;
    const px = (tigerX + 1) / 2 * 800;
    expect(nearestOnScreen(points, camera, px + 10, 400, 800, 800, 20)).toBe('tiger_1');
    expect(nearestOnScreen(points, camera, 700, 100, 800, 800, 20)).toBeNull();
  });
  it('flies smoothly from an island overview down to a chosen animal', () => {
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), surface());
    follow.distance = 2000;
    follow.flyToDistance(8);
    const seen: number[] = [];
    for (let i = 0; i < 180; i++) { follow.follow({ x: 0, z: 0, heading: 0, moving: false }, 1 / 60); seen.push(follow.distance); }
    expect(seen[0]).toBeLessThan(2000); expect(seen[0]).toBeGreaterThan(1000);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
    expect(follow.distance).toBe(8);
    follow.reducedMotion = true; follow.flyToDistance(30);
    expect(follow.distance).toBe(30);
  });
});

describe('turning the view without a right mouse button', () => {
  it('circles a followed animal on a plain drag instead of leaving it', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    let explored = false; follow.onExplore = () => { explored = true; };
    follow.reducedMotion = true;
    follow.follow({ x: 0, z: 0, heading: 0, moving: false }, 1);
    const theta = follow.theta;
    dispatch(target, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 160, clientY: 100 });
    dispatch(target, 'pointerup', { pointerId: 1, clientX: 160, clientY: 100 });
    expect(follow.theta).not.toBe(theta);
    expect(explored).toBe(false);
  });
  it('turns the way the mouse moves, like grabbing the scene: drag down to see it from higher up', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    follow.reducedMotion = true;
    follow.follow({ x: 0, z: 0, heading: 0, moving: false }, 1);
    const theta = follow.theta, phi = follow.phi;
    dispatch(target, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 100, clientY: 160 });
    expect(follow.phi).toBeGreaterThan(phi); // dragged down: looking from higher, as in other 3D viewers
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 100, clientY: 60 });
    expect(follow.phi).toBeLessThan(phi);    // dragged up past the start: lower again
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 160, clientY: 60 });
    expect(follow.theta).toBeLessThan(theta); // dragged right: the scene turns with the cursor
    dispatch(target, 'pointerup', { pointerId: 1, clientX: 160, clientY: 60 });
  });
  it('pans the map on a plain drag while exploring', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    let explored = false; follow.onExplore = () => { explored = true; };
    follow.freeLook(1 / 60);
    const theta = follow.theta;
    dispatch(target, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 160, clientY: 120 });
    expect(follow.theta).toBe(theta);
    expect(explored).toBe(true);
  });
  it('turns on a sideways trackpad swipe and zooms on an upward one', () => {
    const target = surface();
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), target);
    const theta = follow.theta, distance = follow.distance;
    dispatch(target, 'wheel', { deltaX: 40, deltaY: 2, clientX: 0, clientY: 0 });
    expect(follow.theta).toBeGreaterThan(theta);
    expect(follow.distance).toBe(distance);
    dispatch(target, 'wheel', { deltaX: 0, deltaY: 100, clientX: 0, clientY: 0 });
    expect(follow.distance).toBeGreaterThan(distance);
  });
  it('steps, clamps and resets from the on-screen pad', () => {
    const follow = new FollowCamera(new THREE.PerspectiveCamera(), surface());
    follow.rotateBy(1); follow.tiltBy(10); follow.zoomBy(1e-6);
    expect(follow.phi).toBe(1.45);
    expect(follow.distance).toBeGreaterThan(0);
    follow.resetView();
    expect(follow.theta).toBe(0.9); expect(follow.phi).toBe(0.55);
  });
});

describe('following an animal whose position is not known this frame', () => {
  it('keeps applying zoom, turns and flights while holding the last framing', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, .1, 1000);
    const target = surface();
    const follow = new FollowCamera(camera, target);
    follow.reducedMotion = true;
    follow.follow({ x: 10, z: 20, heading: 0, moving: false }, 1);
    const at = follow.target.clone(), before = camera.position.clone();
    follow.zoomBy(2); follow.rotateBy(.5);
    follow.hold(1 / 60);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1);
    expect(camera.position.distanceTo(follow.target)).toBeCloseTo(follow.distance, 3);
    expect(follow.target.toArray()).toEqual(at.toArray());
    // Still following: a plain drag circles the held point rather than exploring away.
    let explored = false; follow.onExplore = () => { explored = true; };
    dispatch(target, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    dispatch(target, 'pointermove', { pointerId: 1, clientX: 160, clientY: 100 });
    expect(explored).toBe(false);
    follow.reducedMotion = false; follow.flyToDistance(80);
    const distance = follow.distance;
    follow.hold(1 / 60);
    expect(follow.distance).toBeGreaterThan(distance);
  });
});
