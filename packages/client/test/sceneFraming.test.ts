import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { applyObserverFraming } from '../src/sceneFraming.js';
import { nearestOnScreen } from '../src/picking.js';

const setup = () => {
  const camera = new PerspectiveCamera(50, 1, 0.3, 12_000);
  const target = new Vector3(10, 2, 20);
  camera.position.set(14, 8, 32); camera.lookAt(target); camera.updateMatrixWorld();
  return { camera, target };
};

describe('observer framing around compact panels', () => {
  it('places the followed point in the available forest and keeps ray and screen picking aligned', () => {
    const { camera, target } = setup(), position = camera.position.clone(), rotation = camera.quaternion.clone();
    const width = 586, height = 668, centerY = (160 + 274) / 2;
    applyObserverFraming(camera, width, height, centerY);
    const projected = target.clone().project(camera);
    expect((projected.x + 1) / 2 * width).toBeCloseTo(width / 2);
    expect((1 - projected.y) / 2 * height).toBeCloseTo(centerY);
    const ray = new Raycaster(); ray.setFromCamera(new Vector2(projected.x, projected.y), camera);
    expect(ray.ray.distanceToPoint(target)).toBeLessThan(1e-10);
    expect(nearestOnScreen(new Map([['followed', target]]), camera, width / 2, centerY, width, height, 8)).toBe('followed');
    expect(nearestOnScreen(new Map([['followed', target]]), camera, width / 2, height / 2, width, height, 8)).toBeNull();
    expect(camera.position).toEqual(position); expect(camera.quaternion.toArray()).toEqual(rotation.toArray()); expect(camera.fov).toBe(50);
  });

  it('uses fresh viewport dimensions on resize and restores ordinary projection when panels clear', () => {
    const { camera, target } = setup();
    const relativeCenter = 217 / 668;
    applyObserverFraming(camera, 586, 668, 217);
    applyObserverFraming(camera, 390, 844, relativeCenter * 844);
    expect(camera.aspect).toBeCloseTo(390 / 844);
    expect(camera.view).toMatchObject({ fullWidth: 390, fullHeight: 844, width: 390, height: 844 });
    expect((1 - target.clone().project(camera).y) / 2 * 844).toBeCloseTo(relativeCenter * 844);
    applyObserverFraming(camera, 1200, 800, null);
    expect(camera.aspect).toBe(1.5); expect(camera.view?.enabled).toBe(false);
    const projected = target.clone().project(camera);
    expect(projected.x).toBeCloseTo(0); expect(projected.y).toBeCloseTo(0);
  });

  it('keeps transient empty layouts from corrupting the projection', () => {
    const { camera } = setup();
    applyObserverFraming(camera, 586, 668, 217);
    const projection = camera.projectionMatrix.clone();
    applyObserverFraming(camera, 0, 0, 0);
    expect(camera.projectionMatrix).toEqual(projection);
    applyObserverFraming(camera, 586, 668, NaN);
    expect(camera.view?.enabled).toBe(false);
    expect(camera.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
  });
});
