import type { AnimalState } from './protocol.js';

/** A small-animal marker must not be larger than the animal it identifies. */
export const markerSize = (heightM: number): number => Math.max(0.12, heightM * 0.22);

/** Mass is a volume; using it directly as height would make newborns implausibly tiny. */
export function characterScale(animal: Pick<AnimalState, 'sizeRatio'>): number {
  const ratio = animal.sizeRatio;
  return ratio === undefined || !Number.isFinite(ratio) ? 1 : Math.cbrt(Math.max(0.027, Math.min(2, ratio)));
}

/** Small inherited coat variation; never replaces an animal's species markings. */
export function coatMultiplier(variant = 0.5): number {
  return 0.86 + Math.max(0, Math.min(1, Number.isFinite(variant) ? variant : 0.5)) * 0.24;
}
