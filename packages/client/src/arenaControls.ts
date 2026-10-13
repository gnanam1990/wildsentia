import type { ArenaFrame } from "@vana/shared";
/** Only a target the server reports as visible and appropriate for this animal. */
export function nearestHuntable(frame: ArenaFrame): string | null {
  const animal = frame.animal;
  if (!animal) return null;
  const allowed = new Set(frame.huntablePrey ?? []);
  return (
    frame.nearby
      .filter((a) => allowed.has(a.id))
      .toSorted(
        (a, b) =>
          Math.hypot(a.x - animal.x, a.z - animal.z) -
          Math.hypot(b.x - animal.x, b.z - animal.z),
      )[0]?.id ?? null
  );
}
