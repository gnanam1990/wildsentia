/**
 * A troop resting up a tree, spread through its crown. The simulation records every climber
 * resting in a patch's tree at that tree's one point, so a whole mangabey troop was drawn inside
 * itself. Presentation only: each resting climber that shares a tree with others is given its own
 * place among the branches, fixed by its id (the same place every frame, whoever else is up
 * there): a spiral out from the trunk, at one of three heights in the crown.
 */
export interface PerchSubject { id: string; x: number; z: number; altitudeM: number; moving: boolean }

/** Climbers within this many metres of each other, aloft, share a tree. */
const SAME_TREE_M = 1.5;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function spreadInCrowns(subjects: readonly PerchSubject[]): Map<string, { x: number; z: number; altitudeM: number }> {
  const trees = new Map<string, PerchSubject[]>();
  for (const s of subjects) {
    if (s.moving || s.altitudeM <= 2) continue;
    const key = `${Math.round(s.x / SAME_TREE_M)}:${Math.round(s.z / SAME_TREE_M)}`;
    const list = trees.get(key) ?? [];
    list.push(s); trees.set(key, list);
  }
  const out = new Map<string, { x: number; z: number; altitudeM: number }>();
  for (const group of trees.values()) {
    if (group.length < 2) continue;
    // Slots by id rank, so a place does not depend on the order the animals arrive in.
    const ranked = [...group].sort((a, b) => hash(a.id) - hash(b.id) || (a.id < b.id ? -1 : 1));
    const trunk = ranked[0]!, turn = hash(`${Math.round(trunk.x)}:${Math.round(trunk.z)}`) * Math.PI * 2;
    ranked.forEach((s, k) => {
      const angle = turn + k * GOLDEN_ANGLE, r = 1.6 + 0.95 * Math.sqrt(k);
      out.set(s.id, { x: trunk.x + Math.sin(angle) * r, z: trunk.z + Math.cos(angle) * r, altitudeM: s.altitudeM - 1.5 + (k % 3) * 1.5 });
    });
  }
  return out;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}
