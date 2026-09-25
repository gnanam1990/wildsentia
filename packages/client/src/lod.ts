export interface LodLimits {
  /** Most animals given a full model at once. */
  max: number;
  /** Beyond this distance from the camera's focus an animal is not drawn. */
  radiusM: number;
}

/** Legacy high-detail budget. Device FPS must be measured, not inferred from model count. */
export const DEFAULT_LOD: LodLimits = { max: 120, radiusM: 800 };

/**
 * Which animals get a model this frame: the nearest to where the camera is looking, inside the
 * radius, up to the budget — and the watched animal always, wherever it is. The forest holds
 * thousands; drawing every one crashed the page once the world grew past its first sixty sambar.
 */
export function chooseVisible(
  positions: ReadonlyMap<string, { x: number; z: number }>,
  focus: { x: number; z: number },
  followedId: string | null,
  limits: LodLimits = DEFAULT_LOD,
): Set<string> {
  const radius2 = limits.radiusM * limits.radiusM;
  const near: Array<[string, number]> = [];
  for (const [id, p] of positions) {
    if (id === followedId) continue;
    const d2 = (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2;
    if (d2 <= radius2) near.push([id, d2]);
  }
  near.sort((a, b) => a[1] - b[1]);

  const visible = new Set<string>();
  if (followedId !== null && positions.has(followedId)) visible.add(followedId);
  for (const [id] of near) {
    if (visible.size >= limits.max) break;
    visible.add(id);
  }
  return visible;
}
