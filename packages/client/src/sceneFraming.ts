import type { PerspectiveCamera } from 'three';

/** Move the camera's look-at point to a CSS-pixel row without moving the observer or subject. */
export function applyObserverFraming(
  camera: PerspectiveCamera, width: number, height: number, centerY: number | null,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  camera.aspect = width / height;
  if (centerY === null || !Number.isFinite(centerY)) {
    camera.clearViewOffset();
    return;
  }
  const row = Math.max(0, Math.min(height, centerY));
  camera.setViewOffset(width, height, 0, height / 2 - row, width, height);
}
