/**
 * Where a natural forest is thick and where it opens up, as a fixed world-space pattern.
 *
 * Placing every tree uniformly at random inside its 300 m patch read as a plantation from
 * above: an even spread of same-aged crowns over bare ground. A real tropical
 * dry-deciduous stand is clumped, with light gaps where saplings and grass come up, thickets
 * of shrubs at the clump edges and older, larger trees where the canopy has been closed longest.
 *
 * `standDensity` is that pattern: a smooth 0-1 field over the island (1 = the heart of a clump,
 * 0 = a clearing). It is a pure function of world position, so plants keep their place as the
 * camera moves and every viewer sees the same forest. It never adds or removes plants: each
 * patch still grows exactly the count its simulated canopy and grass say; the field only
 * decides where inside the patch they stand and how old they look. Presentation only.
 */

/** 32-bit integer lattice hash (murmur3 finaliser), mapped to 0-1. */
function lattice(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise, 0-1, one lattice cell per unit. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = fade(x - ix), fz = fade(z - iz);
  const a = lattice(ix, iz, seed), b = lattice(ix + 1, iz, seed);
  const c = lattice(ix, iz + 1, seed), d = lattice(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

const smoothstep = (lo: number, hi: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Metres per lattice cell of the two octaves: stands of ~100 m and clumps of ~40 m. */
export const STAND_SCALES_M = [95, 38] as const;

/** 0 in a clearing, 1 in the heart of a clump. A fixed function of world position. */
export function standDensity(x: number, z: number): number {
  // A gentle domain warp keeps clumps from lining up with the lattice.
  const wx = x + (valueNoise(x / 140, z / 140, 0x5eed) - 0.5) * 60;
  const wz = z + (valueNoise(x / 140 + 31.7, z / 140 - 12.3, 0x5eed) - 0.5) * 60;
  const v = 0.62 * valueNoise(wx / STAND_SCALES_M[0], wz / STAND_SCALES_M[0], 0x7a11)
    + 0.38 * valueNoise(wx / STAND_SCALES_M[1] + 17.3, wz / STAND_SCALES_M[1] - 9.1, 0x0b5c);
  return smoothstep(0.28, 0.72, v);
}

/** Small-scale patchiness for understory thickets and ground mottling (~12 m). */
export function thicket(x: number, z: number): number {
  return valueNoise(x / 12 + 3.1, z / 12 - 7.7, 0x7417);
}

/** What a plant prefers to stand in. Trees crowd into clumps; grass takes the clearings. */
export type StandPreference = 'canopy' | 'grove' | 'shade' | 'edge' | 'open' | 'none';

export function preferenceFor(kind: string, habitat: string): StandPreference {
  if (kind.includes('Tree') && !kind.startsWith('Dead')) return habitat === 'grassland' ? 'grove' : 'canopy';
  if (/^(Fern_|Mushroom_|Plant_1)/.test(kind)) return 'shade';
  if (/^(Bush_|Plant_7)/.test(kind)) return 'edge';
  if (/^(Grass_|Clover_|Flower_)/.test(kind)) return habitat === 'shola' || habitat === 'riparian' || habitat === 'grassland' ? 'open' : 'none';
  return 'none';
}

/** Chance (0-1) that a plant with this preference keeps a candidate spot. */
export function standAcceptance(preference: StandPreference, stand: number, patchiness = 0.5): number {
  switch (preference) {
    case 'canopy': return 0.06 + 0.94 * smoothstep(0.12, 0.62, stand);
    // A few trees on open grassland, gathered into groves rather than dotted like an orchard.
    case 'grove': return 0.03 + 0.97 * smoothstep(0.45, 0.85, stand);
    // Ferns and herbs in the shade of the clumps, in thickets rather than an even sprinkle.
    case 'shade': return (0.1 + 0.9 * smoothstep(0.3, 0.75, stand)) * (0.35 + 0.65 * smoothstep(0.3, 0.7, patchiness));
    // Shrubs thicken where the canopy breaks: the bright edge of a clump.
    case 'edge': return (0.15 + 0.85 * Math.exp(-(((stand - 0.4) / 0.24) ** 2))) * (0.4 + 0.6 * smoothstep(0.25, 0.7, patchiness));
    case 'open': return 0.12 + 0.88 * (1 - smoothstep(0.25, 0.8, stand));
    default: return 1;
  }
}

/** Candidate spots a plant may try before it settles for the best one it saw. Bounded work. */
export const PLACEMENT_TRIES = 6;

/**
 * A deterministic spot inside a square, preferring the parts of the stand pattern this plant
 * likes. Uses `random` only, so a patch seed still fixes the result. Every call returns a spot:
 * the patch keeps the plant count the simulation implies.
 */
export function standSpot(random: () => number, centre: { x: number; z: number }, span: number,
  preference: StandPreference): { x: number; z: number; stand: number } {
  let best = { x: centre.x, z: centre.z, stand: 0 }, bestScore = -1;
  for (let attempt = 0; attempt < (preference === 'none' ? 1 : PLACEMENT_TRIES); attempt++) {
    const x = centre.x + (random() - 0.5) * span, z = centre.z + (random() - 0.5) * span;
    if (preference === 'none') return { x, z, stand: 0.5 };
    const stand = standDensity(x, z);
    const chance = standAcceptance(preference, stand, preference === 'shade' || preference === 'edge' ? thicket(x, z) : 0.5);
    if (random() < chance) return { x, z, stand };
    if (chance > bestScore) { bestScore = chance; best = { x, z, stand }; }
  }
  return best;
}

export type TreeAge = 'sapling' | 'mature' | 'emergent';

/**
 * A tree's size from one uniform draw and the stand it grows in. Light gaps carry young
 * regeneration; closed clumps carry the old, tall trees. `lo`-`hi` is the kind's mature range.
 */
export function treeAgeScale(lo: number, hi: number, r: number, stand: number): { scale: number; age: TreeAge } {
  const sapling = 0.16 + 0.26 * (1 - stand);
  const emergent = 0.03 + 0.09 * stand;
  if (r < sapling) return { scale: lo * (0.32 + 0.4 * (r / sapling)), age: 'sapling' };
  if (r >= 1 - emergent) return { scale: hi * (1.08 + 0.3 * ((r - (1 - emergent)) / emergent)), age: 'emergent' };
  const t = (r - sapling) / (1 - sapling - emergent);
  // Slightly skewed toward the smaller end: many middle-aged trees, fewer big ones.
  return { scale: lo + (hi - lo) * t ** 1.3, age: 'mature' };
}
