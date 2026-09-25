import * as THREE from 'three';

/**
 * The id whose world point is drawn nearest a screen point, within `radiusPx`. Picking by
 * screen distance makes a distant dot or a hare as easy to tap as an elephant: a world-space
 * ray threshold is either too small from high above or too large up close.
 */
export function nearestOnScreen(
  points: ReadonlyMap<string, { x: number; y: number; z: number }>,
  camera: THREE.Camera,
  x: number, y: number, width: number, height: number, radiusPx: number,
): string | null {
  camera.updateMatrixWorld();
  const projected = new THREE.Vector3();
  let best: string | null = null;
  let bestDistance = radiusPx;
  for (const [id, p] of points) {
    projected.set(p.x, p.y, p.z).project(camera);
    // Behind the camera or beyond the far plane.
    if (projected.z < -1 || projected.z > 1) continue;
    const sx = (projected.x + 1) / 2 * width, sy = (1 - projected.y) / 2 * height;
    const d = Math.hypot(sx - x, sy - y);
    if (d <= bestDistance) { best = id; bestDistance = d; }
  }
  return best;
}
