/** A screen label anchored at its bottom centre (CSS translate(-50%, -100%)). */
export interface LabelBox { x: number; y: number; width: number; height: number }

/**
 * Two labels over animals standing together (a hunter over its prey) would print on top of
 * each other. Stack them instead: the label already higher on screen moves up until the pair
 * no longer overlaps. Returns the second label's new anchor; the first never moves.
 */
export function stackLabels(first: LabelBox, second: LabelBox, gap = 4): { x: number; y: number } {
  const overlapX = Math.abs(first.x - second.x) < (first.width + second.width) / 2;
  const overlapY = Math.abs(first.y - second.y) < (first.y <= second.y ? second.height : first.height) + gap;
  if (!overlapX || !overlapY) return { x: second.x, y: second.y };
  // Keep the screen order the animals already have, so each label stays nearer its own animal.
  return second.y <= first.y ? { x: second.x, y: first.y - first.height - gap } : { x: second.x, y: first.y + second.height + gap };
}
