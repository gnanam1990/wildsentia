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
   * Wright's coefficient of relationship, approximated over a bounded pedigree depth: twice the
   * kinship coefficient. Full siblings and parent-offspring both come out at 0.5; half siblings
   * at 0.25; first cousins at 0.125, however many generations behind them are known.
   *
   * sim_0.38.0: kinship by the recursive (tabular) method, expanding the animal that is not an
   * ancestor of the other. Summing 0.5^(steps) over every common ancestor counted a shared
   * parent again through each of its own ancestors: full siblings with known grandparents came
   * out at 0.75 and half siblings at 0.375, over the mate limit, so lineages stopped breeding.
   */
  relatedness(a: string, b: string, depth = 6): number {
    if (a === b) return 1;
    const lines = new Map<string, Map<string, number>>();
    const ancestors = (id: string) => {
      let found = lines.get(id);
      if (!found) lines.set(id, found = this.ancestorsOf(id, depth));
      return found;
    };
    const memo = new Map<string, number>();
    // Kinship of x and y, x being gx and y gy generations behind the pair asked about.
    const kinship = (x: string, gx: number, y: string, gy: number): number => {
      const key = x < y ? `${x}|${gx}|${y}|${gy}` : `${y}|${gy}|${x}|${gx}`;
      const known = memo.get(key);
      if (known !== undefined) return known;
      let value = 0;
      if (x === y) {
        const parents = this.#parents.get(x);
        const inbreeding = parents?.mother && parents.father && Math.max(gx, gy) < depth
          ? kinship(parents.mother, Math.max(gx, gy) + 1, parents.father, Math.max(gx, gy) + 1) : 0;
        value = 0.5 * (1 + inbreeding);
      } else {
        const [e, ge, o, go] = ancestors(y).has(x) ? [y, gy, x, gx] : [x, gx, y, gy];
        const parents = this.#parents.get(e);
        if (parents && ge < depth) {
          if (parents.mother !== null) value += 0.5 * kinship(parents.mother, ge + 1, o, go);
          if (parents.father !== null) value += 0.5 * kinship(parents.father, ge + 1, o, go);
        }
      }
      memo.set(key, value);
      return value;
    };
    return Math.min(1, 2 * kinship(a, 0, b, 0));
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
