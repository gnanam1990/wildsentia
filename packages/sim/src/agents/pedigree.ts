/**
 * Who descends from whom. Kept separate from the agents themselves so it survives their death:
 * a lineage has to outlive every animal in it.
 */
export class Pedigree {
  readonly #parents = new Map<string, { mother: string | null; father: string | null }>();

  record(childId: string, motherId: string | null, fatherId: string | null): void {
    this.#parents.set(childId, { mother: motherId, father: fatherId });
  }

  parentsOf(id: string): { mother: string | null; father: string | null } | null {
    return this.#parents.get(id) ?? null;
  }

  /** Ancestors of `id` mapped to how many generations back the nearest path to them is. */
  ancestorsOf(id: string, depth = 6): Map<string, number> {
    const found = new Map<string, number>();
    const queue: Array<{ id: string; generations: number }> = [{ id, generations: 0 }];
    const seen = new Set<string>([id]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.generations >= depth) continue;
      const parents = this.#parents.get(current.id);
      if (parents === undefined) continue;

      for (const parentId of [parents.mother, parents.father]) {
        if (parentId === null) continue;
        const generations = current.generations + 1;
        if (!found.has(parentId) || found.get(parentId)! > generations) {
          found.set(parentId, generations);
        }
        // A cycle cannot happen in a real pedigree, but a corrupted one must not hang the world.
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        queue.push({ id: parentId, generations });
      }
    }
    return found;
  }

  /**
   * Wright's coefficient of relationship, approximated over a bounded pedigree depth.
   * Full siblings and parent-offspring both come out at 0.5; half siblings at 0.25.
   */
  relatedness(a: string, b: string, depth = 6): number {
    if (a === b) return 1;

    const ancestorsA = this.ancestorsOf(a, depth);
    const ancestorsB = this.ancestorsOf(b, depth);

    // A direct line counts on its own: a parent is an ancestor of its child.
    let total = 0;
    if (ancestorsA.has(b)) total += 0.5 ** ancestorsA.get(b)!;
    if (ancestorsB.has(a)) total += 0.5 ** ancestorsB.get(a)!;

    for (const [ancestor, stepsA] of ancestorsA) {
      const stepsB = ancestorsB.get(ancestor);
      if (stepsB === undefined) continue;
      total += 0.5 ** (stepsA + stepsB);
    }
    return Math.min(1, total);
  }

  /** The inbreeding coefficient a pairing would give its offspring: half the parents' relatedness. */
  coefficientFor(motherId: string, fatherId: string, depth = 6): number {
    return this.relatedness(motherId, fatherId, depth) / 2;
  }

  size(): number {
    return this.#parents.size;
  }

  clear(): void {
    this.#parents.clear();
  }

  /** @internal — snapshot support. */
  toJSON(): Array<[string, { mother: string | null; father: string | null }]> {
    return [...this.#parents.entries()];
  }

  /** @internal — snapshot support. */
  static fromJSON(entries: Array<[string, { mother: string | null; father: string | null }]>): Pedigree {
    const pedigree = new Pedigree();
    for (const [childId, parents] of entries) pedigree.record(childId, parents.mother, parents.father);
    return pedigree;
  }
}
