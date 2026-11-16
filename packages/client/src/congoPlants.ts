import * as THREE from 'three';
import { addCongoDeciduous } from './seasonalLeaves.js';
import { congoTexture, LEAF_ATLAS_TILES } from './congoTextures.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { congoChannelHalfM, congoRivers, patchCentre, riverIndex, spatialHash, treeAnchorForPatch, type RiverPath } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import type { PatchView } from './terrain.js';

/**
 * Congo 1A.5: the plants of a Congo rainforest, built procedurally and dressed in photographic
 * bark and leaf textures (congoTextures.ts).
 * - Terra firme is a layered forest: emergents with pale buttressed trunks and flat crowns over
 *   a closed canopy, a midstory, saplings, and an understory of broad Marantaceae leaves.
 * - Swamps grow Raphia palms; flooded forest a lower canopy with palms; bais are open sedge.
 * - Rocks lie only along river banks; fallen logs on the forest floor.
 */
export const CONGO_KINDS = ['emergent', 'canopy', 'midstory', 'sapling', 'raphia', 'marantaceae', 'herb', 'groundcover', 'sedge', 'log', 'rock'] as const;
export type CongoKind = typeof CONGO_KINDS[number];

/** The parts of a plant, each drawn with its own material: bark and wood, textured leaf clusters, solid blades. */
export interface PlantParts { wood?: THREE.BufferGeometry; leaves?: THREE.BufferGeometry; blades?: THREE.BufferGeometry }

/** Plants per 300 m patch (9 ha) of each habitat, near the camera. */
const PER_PATCH: Record<string, Partial<Record<CongoKind, number>>> = {
  terra_firme: { emergent: 12, canopy: 190, midstory: 280, sapling: 600, marantaceae: 3500, herb: 14000, groundcover: 40000, log: 6 },
  flooded_forest: { canopy: 150, midstory: 200, raphia: 20, sapling: 260, marantaceae: 900, herb: 3000, groundcover: 30000, log: 4 },
  swamp_forest: { raphia: 200, canopy: 50, midstory: 100, sapling: 160, marantaceae: 1200, herb: 6000, groundcover: 22000 },
  bai: { sedge: 9000, log: 2 },
};
/** Bank rocks tried per patch beside a river; kept only within this distance of the channel's edge. */
const ROCK_TRIES = 40, ROCK_BANK_M = 80;

export interface PlacedPlant { kind: CongoKind; x: number; z: number; scale: number; rotY: number }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

let rivers: { seed: number; list: RiverPath[]; near: ReturnType<typeof riverIndex>; widestHalf: number } | null = null;
function riversOf(seed: number) {
  if (rivers?.seed !== seed) {
    const list = congoRivers(seed, worldGrid());
    rivers = { seed, list, near: riverIndex(list), widestHalf: Math.max(...list.map((r) => congoChannelHalfM(r, worldGrid()))) };
  }
  return rivers;
}

/**
 * What grows in one patch: the same plants, in the same places, every time. `kinds` plans only
 * those kinds, each exactly as it stands in the whole plan (each kind draws from its own sequence).
 */
export function planCongoPatch(patch: Pick<PatchView, 'id' | 'habitat'> & Partial<Pick<PatchView, 'canopyCover' | 'surface'>>, seed: number,
  kinds?: ReadonlySet<CongoKind>): PlacedPlant[] {
  // A river patch is water only where its channel runs; its dry edge grows the flooded forest's plants.
  const counts = PER_PATCH[patch.habitat === 'water' ? 'flooded_forest' : patch.habitat];
  if (!counts) return [];
  const grid = worldGrid(), centre = patchCentre(grid, patch.id), half = grid.patchM / 2, { near, widestHalf } = riversOf(seed);
  // Most patches lie far from every river: then no plant can stand in a channel, and none needs a lookup.
  const fromRiver = near(centre.x, centre.z).distanceM - half * Math.SQRT2;
  const inChannel = fromRiver > widestHalf + 3 ? () => false
    : (x: number, z: number) => { const at = near(x, z); return at.distanceM <= congoChannelHalfM(at.river, grid) + 3; };
  const out: PlacedPlant[] = [];
  for (const kind of CONGO_KINDS) {
    const n = kind === 'rock' ? 0 : counts[kind] ?? 0;
    if (n === 0 || (kinds && !kinds.has(kind))) continue;
    const random = rng(spatialHash(`congo-plants:${seed}:${patch.id}:${kind}`));
    const tree = kind === 'emergent' || kind === 'canopy' || kind === 'midstory';
    for (let i = 0; i < n; i++) {
      const x = centre.x + (random() * 2 - 1) * half, z = centre.z + (random() * 2 - 1) * half;
      const scale = tree ? 0.8 + random() * 0.35 : 0.7 + random() * 0.6, rotY = random() * Math.PI * 2;
      if (!inChannel(x, z)) out.push({ kind, x, z, scale, rotY });
    }
  }
  // Where an animal climbs or a bird perches (shared/treeAnchor.ts), a real canopy tree stands, at
  // the size the heights there are measured on: limbs 23-30 m, crown to 34 m.
  const anchor = !kinds || kinds.has('canopy') ? treeAnchorForPatch(grid, patch) : null;
  if (anchor && !inChannel(anchor.x, anchor.z)) out.push({ kind: 'canopy', x: anchor.x, z: anchor.z, scale: 1, rotY: spatialHash(`congo-climb-tree:${patch.id}`) / 0x1_0000_0000 * Math.PI * 2 });
  if (patch.habitat !== 'bai' && (!kinds || kinds.has('rock')) && fromRiver <= widestHalf + ROCK_BANK_M) {
    const random = rng(spatialHash(`congo-plants:${seed}:${patch.id}:rock`));
    for (let i = 0; i < ROCK_TRIES; i++) {
      const x = centre.x + (random() * 2 - 1) * half, z = centre.z + (random() * 2 - 1) * half, scale = 0.5 + random() * 1.2, rotY = random() * Math.PI * 2;
      const at = near(x, z), edge = congoChannelHalfM(at.river, grid);
      if (at.distanceM > edge + 3 && at.distanceM <= edge + ROCK_BANK_M) out.push({ kind: 'rock', x, z, scale, rotY });
    }
  }
  return out;
}

// ---- Geometry ---------------------------------------------------------------------------------

/** Gives every vertex a colour and drops index and attributes the merge does not share. */
function finish(geometry: THREE.BufferGeometry, colour: (y: number, i: number) => THREE.Color): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const p = g.getAttribute('position'), colours = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const c = colour(p.getY(i), i); colours.set([c.r, c.g, c.b], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
  return g;
}

/** Bark repeats every this many metres along and around a trunk. */
const BARK_TILE_M = 2.2;
/** Stretches a cylinder's 0-1 UVs so its bark texture keeps its size on any trunk. */
function barkUvs(g: THREE.BufferGeometry, radius: number, height: number): THREE.BufferGeometry {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(2 * Math.PI * radius / BARK_TILE_M)), uv.getY(i) * height / BARK_TILE_M);
  return g;
}

/** A tapering trunk, its bark tinted a little, with faint darker streaks. */
function trunk(height: number, r0: number, r1: number, bark: number, random: () => number): THREE.BufferGeometry {
  const g = barkUvs(new THREE.CylinderGeometry(r1, r0, height, 12, 6, true).translate(0, height / 2, 0), (r0 + r1) / 2, height);
  const base = new THREE.Color(bark).lerp(new THREE.Color(0xffffff), 0.6), streak = base.clone().multiplyScalar(0.82);
  const shade = Array.from({ length: 12 * 7 * 2 }, () => random());
  return finish(g, (_y, i) => base.clone().lerp(streak, shade[i % shade.length]! * 0.6));
}

/** Plank buttresses: fins running out from the trunk's foot all round, as Congo canopy trees stand on. */
function buttresses(count: number, height: number, reach: number, trunkR: number, colour: number, random: () => number): THREE.BufferGeometry[] {
  const fins: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) fins.push(buttressFin(height, reach, trunkR, colour, random).rotateY((i / count) * Math.PI * 2 + random() * 0.4));
  return fins;
}

/**
 * One plank buttress running out along +x from a trunk of radius `trunkR`. Its top edge sweeps
 * down from high on the trunk to the ground in a concave curve (a straight slope read as a flat
 * triangle), it thins from the trunk to its tip and wanders a little sideways, and it reaches
 * 0.3 m into the ground so it meets the floor on a slope. Its bark is the trunk's, tiled the same.
 */
export function buttressFin(height: number, reach: number, trunkR: number, colour: number, random: () => number): THREE.BufferGeometry {
  const steps = 10, h = height * (0.8 + random() * 0.4), r = reach * (0.8 + random() * 0.4), wander = (random() - 0.5) * 0.6, x0 = trunkR * 0.6;
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps, x = x0 + (r - x0) * t, top = h * Math.pow(1 - t, 2.4) + 0.05, half = 0.2 * (1 - t) + 0.025, z = wander * t * t;
    // Four edges a station: the two faces' feet and their tops.
    for (const [y, side] of [[-0.3, -1], [top, -1], [top, 1], [-0.3, 1]] as const) {
      positions.push(x, y, z + side * half);
      uvs.push(x / BARK_TILE_M, (y + 0.3) / BARK_TILE_M);
    }
    if (k === 0) continue;
    const a = (k - 1) * 4, b = k * 4;
    // The near face, the top and the far face, wound outward.
    index.push(a, b, a + 1, b, b + 1, a + 1, a + 1, b + 1, a + 2, b + 1, b + 2, a + 2, a + 2, b + 2, a + 3, b + 2, b + 3, a + 3);
  }
  const tip = steps * 4;
  index.push(tip, tip + 3, tip + 1, tip + 3, tip + 2, tip + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  const base = new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.6);
  return finish(g, () => base);
}

/** Branches from the upper trunk out under the crown. */
function limbs(count: number, fromY: number, length: number, radius: number, colour: number, random: () => number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const limb = barkUvs(new THREE.CylinderGeometry(radius * 0.5, radius, length, 6).translate(0, length / 2, 0), radius, length)
      .rotateZ(-(0.7 + random() * 0.5)).rotateY((i / count) * Math.PI * 2 + random()).translate(0, fromY + random() * 3, 0);
    out.push(finish(limb, () => new THREE.Color(colour).lerp(new THREE.Color(0xffffff), 0.55)));
  }
  return out;
}

/** Lianas: woody vines hanging in loose loops from the crown's limbs to the forest floor. */
function lianas(count: number, fromY: number, reach: number, random: () => number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const yaw = random() * Math.PI * 2, r = reach * (0.5 + random() * 0.5), top = fromY - random() * 3;
    const along = (t: number, sag: number) => new THREE.Vector3(Math.cos(yaw) * r * (1 - t * 0.15) + sag, top * (1 - t), Math.sin(yaw) * r * (1 - t * 0.15));
    const curve = new THREE.CatmullRomCurve3([along(0, 0), along(0.3, 0.8 + random()), along(0.62, -0.6 - random()), along(1, 0.4)]);
    const vine = new THREE.TubeGeometry(curve, 10, 0.05 + random() * 0.05, 3, false);
    const uv = vine.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * top / BARK_TILE_M, uv.getY(k) * 0.3);
    out.push(finish(vine, () => new THREE.Color(0xc8bca6)));
  }
  return out;
}

/**
 * Leaf clusters: cards scattered through a flattened crown, each carrying one of the leaf atlas's
 * sprays (`tiles` of them, from the first) and its own slight shade.
 */
function crown(cards: number, size: number, centreY: number, rx: number, ry: number, random: () => number, tiles = LEAF_ATLAS_TILES): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < cards; i++) {
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * rx, y = centreY + (random() * 2 - 1) * ry * (1 - (r / rx) * 0.5);
    const card = new THREE.PlaneGeometry(size * (0.7 + random() * 0.6), size * (0.7 + random() * 0.6))
      .rotateX(-Math.PI / 2 + (random() - 0.5) * 1.9).rotateY(random() * Math.PI * 2)
      .translate(Math.cos(a) * r, y, Math.sin(a) * r);
    const tile = Math.floor(random() * tiles), uv = card.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, (uv.getX(k) + (tile % 2)) / 2, (uv.getY(k) + 1 - Math.floor(tile / 2)) / 2);
    const v = random(), tint = new THREE.Color(0.82 + v * 0.26, 0.86 + v * 0.22, 0.8 + v * 0.18);
    parts.push(finish(card, () => tint));
  }
  return mergeGeometries(parts)!;
}

/**
 * A textured leaf on a stalk's tip: a plane cut by its leaf's alpha, cupped along its length.
 * `aspect` is the leaf image's width over its height.
 */
/**
 * One upright card showing tile 0-3 of a 2 x 2 atlas (0 top left, 1 top right, 2 bottom left, 3
 * bottom right), `h` tall and wide, its base on the ground at (x, z), turned by `turn`. A slight
 * random tint keeps neighbours from matching.
 */
function atlasCard(h: number, tile: number, turn: number, x: number, z: number, v: number): THREE.BufferGeometry {
  const card = new THREE.PlaneGeometry(h, h).translate(0, h / 2, 0).rotateY(turn).translate(x, 0, z), uv = card.getAttribute('uv');
  const col = tile % 2, row = Math.floor(tile / 2);
  // Textures load flipped, so the image's top row is v 0.5-1.
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + col) / 2, (uv.getY(i) + 1 - row) / 2);
  return finish(card, () => new THREE.Color(0.86 + v * 0.18, 0.88 + v * 0.16, 0.84 + v * 0.16));
}

function leafCard(length: number, aspect: number, cup: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(length * aspect, length, 2, 4).translate(0, length / 2, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / length, across = p.getX(i) / (length * aspect);
    p.setZ(i, cup * (t * t * 0.6 + across * across * 0.8) * length);
  }
  g.computeVertexNormals();
  return g;
}

function plantParts(kind: CongoKind): PlantParts {
  const random = rng(spatialHash(`congo-geometry:${kind}`));
  const merge = (list: THREE.BufferGeometry[]) => mergeGeometries(list)!;
  switch (kind) {
    case 'emergent':
      return { wood: merge([trunk(44, 0.95, 0.5, 0xb7a990, random), ...buttresses(5, 5, 3.4, 0.95, 0xb7a990, random), ...limbs(5, 37, 9, 0.35, 0x9a8c72, random)]),
        leaves: crown(220, 4.5, 46, 12, 3.6, random) };
    case 'canopy':
      return { wood: merge([trunk(28, 0.6, 0.32, 0x8c7c64, random), ...buttresses(3, 2.6, 1.8, 0.6, 0x8c7c64, random), ...limbs(4, 23, 6, 0.22, 0x7a6a52, random), ...lianas(3, 25, 5, random)]),
        leaves: crown(190, 4.2, 29.5, 8.5, 4.2, random) };
    case 'midstory':
      return { wood: trunk(14, 0.26, 0.14, 0x6e604c, random), leaves: crown(70, 2.8, 14, 4.2, 3, random) };
    case 'sapling':
      return { wood: trunk(3.6, 0.06, 0.03, 0x5e5240, random), leaves: crown(12, 0.9, 3.1, 0.8, 0.7, random) };
    case 'raphia': {
      // Raphia: a short trunk and long fronds arching out, each a rachis with drooping leaflets.
      // Each frond is the photographed frond's image on a strip arching out and down, its
      // leaflets drooping to both sides.
      const fronds: THREE.BufferGeometry[] = [];
      for (let f = 0; f < 16; f++) {
        const yaw = (f / 16) * Math.PI * 2 + random() * 0.3, lift = 0.45 + random() * 0.55, length = 8.5 + random() * 2.5;
        const strip = new THREE.PlaneGeometry(length * 0.3, length, 4, 10).translate(0, length / 2, 0), p = strip.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          const along = p.getY(i), across = p.getX(i);
          p.setXYZ(i, along * Math.cos(lift), Math.sin(lift) * along - 0.045 * along * along - 0.35 * Math.abs(across), across);
        }
        strip.computeVertexNormals();
        const v = random();
        fronds.push(finish(strip, () => new THREE.Color(0.85 + v * 0.2, 0.9 + v * 0.15, 0.8 + v * 0.15)).rotateY(yaw).translate(0, 7, 0));
      }
      return { wood: trunk(7, 0.42, 0.34, 0x4f4232, random), blades: merge(fronds) };
    }
    case 'marantaceae': {
      // Broad paddle leaves on long stalks, 1-2.5 m tall: the Congo forest's understory.
      const leaves: THREE.BufferGeometry[] = [], stalks: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 14; k++) {
        const yaw = random() * Math.PI * 2, height = 0.6 + random() * 1.4, lean = 0.15 + random() * 0.3;
        stalks.push(finish(new THREE.CylinderGeometry(0.012, 0.02, height, 4).translate(0, height / 2, 0).rotateZ(lean).rotateY(yaw), () => new THREE.Color(0x4d6b2a)));
        const tip = new THREE.Vector3(0, height, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), lean).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const v = random(), tint = new THREE.Color(0.85 + v * 0.25, 0.9 + v * 0.2, 0.85 + v * 0.15);
        leaves.push(finish(leafCard(0.4 + random() * 0.25, 0.67, 0.18).rotateX(-1.1 + random() * 0.4).rotateY(yaw).translate(tip.x, tip.y, tip.z), () => tint));
      }
      return { wood: merge(stalks), blades: merge(leaves) };
    }
    case 'herb': {
      // Seedlings and small herbs carpeting the floor between the larger plants: ankle to shin high
      // (a blue duiker stands 36 cm at the shoulder). Each is a photographed seedling on two crossed
      // cards, from a 2 x 2 atlas (a tree seedling, a ragged herb, a fern sprout, a bronze-flushed one).
      const cards: THREE.BufferGeometry[] = [];
      for (let s = 0; s < 3; s++) {
        const h = 0.14 + random() * 0.24, tile = Math.floor(random() * 4), x = (random() - 0.5) * 0.5, z = (random() - 0.5) * 0.5, turn = random() * Math.PI;
        for (let k = 0; k < 2; k++) cards.push(atlasCard(h, tile, turn + k * Math.PI / 2, x, z, random()));
      }
      return { blades: merge(cards) };
    }
    case 'groundcover': {
      // The forest floor's carpet: tufts of broad-leaved forest grass (as Olyra), young ferns, a
      // Marantaceae shoot among seedlings, and herbs with drying leaves, 0.3-0.6 m, four clumps a
      // metre or so apart, each from a 2 x 2 atlas on crossed cards.
      const cards: THREE.BufferGeometry[] = [];
      for (let c = 0; c < 4; c++) {
        const h = 0.3 + random() * 0.3, tile = Math.floor(random() * 4), x = (random() - 0.5) * 1.4, z = (random() - 0.5) * 1.4, turn = random() * Math.PI;
        for (let k = 0; k < 2; k++) cards.push(atlasCard(h, tile, turn + k * Math.PI / 2, x, z, random()));
      }
      return { blades: merge(cards) };
    }
    case 'sedge': {
      // A bai's sedge tuft: the photographed clump on three crossed cards, about knee to waist high.
      const cards: THREE.BufferGeometry[] = [], h = 1.1;
      for (let k = 0; k < 3; k++) {
        const v = random(), tint = new THREE.Color(0.85 + v * 0.2, 0.9 + v * 0.15, 0.8 + v * 0.15);
        cards.push(finish(new THREE.PlaneGeometry(h, h).translate(0, h / 2, 0).rotateY((k / 3) * Math.PI + random() * 0.3), () => tint));
      }
      return { blades: merge(cards) };
    }
    case 'log': {
      // Light tints: the bark photograph carries the log's darkness (dark tints over it drew a black log).
      const moss = new THREE.Color(0x9aa86a), bark = new THREE.Color(0xc2ad8c);
      const log = new THREE.CylinderGeometry(0.5, 0.6, 11, 8).rotateZ(Math.PI / 2).translate(0, 0.45, 0);
      return { wood: finish(log, (y) => bark.clone().lerp(moss, Math.max(0, Math.min(1, (y - 0.45) / 0.6)))) };
    }
    case 'rock': {
      const rock = new THREE.DodecahedronGeometry(1.1, 1).scale(1, 0.6, 0.85).translate(0, 0.3, 0);
      const p = rock.getAttribute('position');
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.85 + random() * 0.3), p.getY(i), p.getZ(i) * (0.85 + random() * 0.3));
      return { wood: finish(rock, (y) => new THREE.Color(0x6d6458).lerp(new THREE.Color(0x4a5a34), Math.max(0, y - 0.5))) };
    }
  }
}

const partsCache = new Map<CongoKind, PlantParts>();
/** A kind's parts, built once. */
export function congoPlantParts(kind: CongoKind): PlantParts {
  let parts = partsCache.get(kind);
  if (!parts) { parts = plantParts(kind); partsCache.set(kind, parts); }
  return parts;
}

/** All a kind's parts in one geometry (its extent and colours, for tests and bounds). */
export function congoPlantGeometry(kind: CongoKind): THREE.BufferGeometry {
  const { wood, leaves, blades } = congoPlantParts(kind);
  return mergeGeometries([wood, leaves, blades].filter((g): g is THREE.BufferGeometry => g !== undefined))!;
}

// ---- Materials --------------------------------------------------------------------------------

/** A cluster of small leaves drawn on a canvas: the leaf cards' stand-in until the photographed atlas loads, and in tests. */
function canvasLeaves(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = rng(17);
  for (let i = 0; i < 150; i++) {
    const r = Math.sqrt(random()) * size * 0.46, a = random() * Math.PI * 2;
    ctx.fillStyle = `hsl(${88 + random() * 30}, ${38 + random() * 25}%, ${26 + random() * 22}%)`;
    ctx.beginPath(); ctx.ellipse(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, 7 + random() * 7, 3 + random() * 3, random() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The leaf atlas (photographed sprays), or the canvas stand-in where there is no browser. */
function leafMap(): THREE.Texture | null { return congoTexture('leaves_atlas') ?? canvasLeaves(); }

/** Which bark each kind's wood wears: pale smooth emergents, brown fissured canopy, fibrous palms. */
const BARK: Partial<Record<CongoKind, 'bark_pale' | 'bark_brown' | 'bark_raphia'>> = {
  emergent: 'bark_pale', canopy: 'bark_brown', midstory: 'bark_brown', sapling: 'bark_brown', raphia: 'bark_raphia', log: 'bark_brown',
};

const woods = new Map<string, THREE.Material>();
const bladeMaterials = new Map<string, THREE.Material>();
let leafDepth: THREE.MeshDepthMaterial | null = null;
let leaves: THREE.Material | null = null;
let crowns: { leaves: THREE.Material; depth: THREE.MeshDepthMaterial } | null = null;
/** The world's season as a deciduous crown's dryness (seasonalLeaves.ts), shared by every tall tree. */
export const congoSeasonDry = { value: 0 };

function leafMaterial(map: THREE.Texture | null): THREE.MeshStandardMaterial {
  // A faint green glow stands in for light through the leaves, so a crown's underside is not black.
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide, emissive: 0x0c1c06,
    ...(map ? { map, alphaTest: 0.5 } : {}) });
}

/**
 * The leaf clusters' shadow: cut by the same leaf texture, so a crown casts dappled shade, not
 * the solid squares of its cards.
 */
export function congoLeafDepthMaterial(): THREE.MeshDepthMaterial {
  const map = leafMap();
  return leafDepth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...(map ? { map, alphaTest: 0.5 } : {}) });
}
/**
 * The tall trees' leaves (emergents and canopy): the same leaves, but their deciduous share of
 * crowns turns and sheds in the drier spells. The understory beneath stays evergreen.
 */
export function congoCrownMaterials(): { leaves: THREE.Material; depth: THREE.MeshDepthMaterial } {
  if (crowns) return crowns;
  const map = leafMap();
  const leaves = leafMaterial(map);
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...(map ? { map, alphaTest: 0.5 } : {}) });
  addCongoDeciduous(leaves, congoSeasonDry, 'leaves');
  addCongoDeciduous(depth, congoSeasonDry, 'depth');
  return crowns = { leaves, depth };
}

/** The material for one part of one kind of plant. */
export function congoPartMaterial(kind: CongoKind, part: keyof PlantParts): THREE.Material {
  if (part === 'leaves') return leaves ??= leafMaterial(leafMap());
  if (part === 'wood') {
    const bark = BARK[kind], key = bark ?? 'plain';
    let wood = woods.get(key);
    if (!wood) {
      const map = bark ? congoTexture(bark) : null;
      wood = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, ...(map ? { map } : {}) });
      woods.set(key, wood);
    }
    return wood;
  }
  // Blades: the Marantaceae's photographed leaf for the understory, the seedlings and floor clumps from
  // their atlases, the frond for Raphia, the clump for sedge. Matte: a forest-floor leaf is not plastic.
  const image = kind === 'marantaceae' ? 'marantaceae' : kind === 'herb' ? 'seedlings' : kind === 'raphia' ? 'raphia_frond' : kind === 'sedge' ? 'sedge_clump' : kind === 'groundcover' ? 'groundcover' : null,
    key = image ?? 'plain';
  let blade = bladeMaterials.get(key);
  if (!blade) {
    const map = image ? congoTexture(image) : null;
    blade = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, side: THREE.DoubleSide, emissive: 0x0a1a06,
      ...(map ? { map, alphaTest: 0.5 } : {}) });
    bladeMaterials.set(key, blade);
  }
  return blade;
}

/** The ankle- to shin-high floor plants' materials: too low to hide an animal, so never cut away. */
export function congoFloorPlantMaterials(): THREE.Material[] {
  return [congoPartMaterial('herb', 'blades'), congoPartMaterial('groundcover', 'blades')];
}

/** Every material the Congo's plants are drawn with (one each, shared by all instances). */
export function congoPlantMaterials(): THREE.Material[] {
  const all = new Set<THREE.Material>();
  for (const kind of CONGO_KINDS) for (const part of Object.keys(congoPlantParts(kind)) as Array<keyof PlantParts>) all.add(congoPartMaterial(kind, part));
  return [...all];
}
