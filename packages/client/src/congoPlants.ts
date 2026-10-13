import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { congoChannelHalfM, congoRivers, patchCentre, riverIndex, spatialHash, type RiverPath } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import type { PatchView } from './terrain.js';

/**
 * Congo 1A.5: the plants of a Congo rainforest, built procedurally (no downloaded models).
 * - Terra firme is a layered forest: emergents with pale buttressed trunks and flat crowns over
 *   a closed canopy, a midstory, saplings, and an understory of broad Marantaceae leaves.
 * - Swamps grow Raphia palms; flooded forest a lower canopy with palms; bais are open sedge.
 * - Rocks lie only along river banks; fallen logs on the forest floor.
 */
export const CONGO_KINDS = ['emergent', 'canopy', 'midstory', 'sapling', 'raphia', 'marantaceae', 'sedge', 'log', 'rock'] as const;
export type CongoKind = typeof CONGO_KINDS[number];

/** The parts of a plant, each drawn with its own material: bark and wood, textured leaf clusters, solid blades. */
export interface PlantParts { wood?: THREE.BufferGeometry; leaves?: THREE.BufferGeometry; blades?: THREE.BufferGeometry }

/** Plants per 300 m patch (9 ha) of each habitat, near the camera. */
const PER_PATCH: Record<string, Partial<Record<CongoKind, number>>> = {
  terra_firme: { emergent: 9, canopy: 100, midstory: 150, sapling: 220, marantaceae: 700, log: 5 },
  flooded_forest: { canopy: 80, midstory: 110, raphia: 12, sapling: 90, marantaceae: 150, log: 3 },
  swamp_forest: { raphia: 140, canopy: 30, midstory: 60, sapling: 60, marantaceae: 200 },
  bai: { sedge: 1200, log: 2 },
};
/** Bank rocks tried per patch beside a river; kept only within this distance of the channel's edge. */
const ROCK_TRIES = 40, ROCK_BANK_M = 80;

export interface PlacedPlant { kind: CongoKind; x: number; z: number; scale: number; rotY: number }

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}

let rivers: { seed: number; list: RiverPath[]; near: ReturnType<typeof riverIndex> } | null = null;
function riversOf(seed: number) {
  if (rivers?.seed !== seed) { const list = congoRivers(seed, worldGrid()); rivers = { seed, list, near: riverIndex(list) }; }
  return rivers;
}

/** What grows in one patch: the same plants, in the same places, every time. */
export function planCongoPatch(patch: Pick<PatchView, 'id' | 'habitat'>, seed: number): PlacedPlant[] {
  const counts = PER_PATCH[patch.habitat];
  if (!counts) return [];
  const grid = worldGrid(), centre = patchCentre(grid, patch.id), half = grid.patchM / 2, { near } = riversOf(seed);
  const random = rng(spatialHash(`congo-plants:${seed}:${patch.id}`));
  const out: PlacedPlant[] = [];
  const inChannel = (x: number, z: number) => { const at = near(x, z); return at.distanceM <= congoChannelHalfM(at.river, grid) + 3; };
  for (const kind of CONGO_KINDS) {
    const n = counts[kind] ?? 0;
    for (let i = 0; i < n; i++) {
      const x = centre.x + (random() * 2 - 1) * half, z = centre.z + (random() * 2 - 1) * half;
      const scale = kind === 'emergent' || kind === 'canopy' || kind === 'midstory' ? 0.8 + random() * 0.35 : 0.7 + random() * 0.6;
      const rotY = random() * Math.PI * 2;
      if (!inChannel(x, z)) out.push({ kind, x, z, scale, rotY });
    }
  }
  if (patch.habitat !== 'bai') for (let i = 0; i < ROCK_TRIES; i++) {
    const x = centre.x + (random() * 2 - 1) * half, z = centre.z + (random() * 2 - 1) * half, scale = 0.5 + random() * 1.2, rotY = random() * Math.PI * 2;
    const at = near(x, z), edge = congoChannelHalfM(at.river, grid);
    if (at.distanceM > edge + 3 && at.distanceM <= edge + ROCK_BANK_M) out.push({ kind: 'rock', x, z, scale, rotY });
  }
  return out;
}

// ---- Geometry ---------------------------------------------------------------------------------

const GREENS = [0x2b4f1f, 0x355e24, 0x3f6b29, 0x4a7a2f, 0x2f5627, 0x51803a].map((c) => new THREE.Color(c));

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

/** A tapering trunk with darker streaks of bark. */
function trunk(height: number, r0: number, r1: number, bark: number, random: () => number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, height, 9, 6, true).translate(0, height / 2, 0);
  const base = new THREE.Color(bark), streak = base.clone().multiplyScalar(0.72);
  const shade = Array.from({ length: 9 * 7 * 2 }, () => random());
  return finish(g, (_y, i) => base.clone().lerp(streak, shade[i % shade.length]! * 0.6));
}

/** Plank buttresses: thin fins running out from the trunk's foot, as Congo canopy trees stand on. */
function buttresses(count: number, height: number, reach: number, colour: number, random: () => number): THREE.BufferGeometry[] {
  const fins: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(reach * (0.8 + random() * 0.4), 0), new THREE.Vector2(0, height * (0.8 + random() * 0.4))]);
    const fin = new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false }).translate(0, 0, -0.09)
      .rotateY((i / count) * Math.PI * 2 + random() * 0.4);
    fins.push(finish(fin, () => new THREE.Color(colour)));
  }
  return fins;
}

/** Branches from the upper trunk out under the crown. */
function limbs(count: number, fromY: number, length: number, radius: number, colour: number, random: () => number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const limb = new THREE.CylinderGeometry(radius * 0.5, radius, length, 5).translate(0, length / 2, 0)
      .rotateZ(-(0.7 + random() * 0.5)).rotateY((i / count) * Math.PI * 2 + random()).translate(0, fromY + random() * 3, 0);
    out.push(finish(limb, () => new THREE.Color(colour)));
  }
  return out;
}

/** Leaf clusters: cards scattered through a flattened crown, each tinted a different green. */
function crown(cards: number, size: number, centreY: number, rx: number, ry: number, random: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < cards; i++) {
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * rx, y = centreY + (random() * 2 - 1) * ry * (1 - (r / rx) * 0.5);
    const card = new THREE.PlaneGeometry(size * (0.7 + random() * 0.6), size * (0.7 + random() * 0.6))
      .rotateX(-Math.PI / 2 + (random() - 0.5) * 1.3).rotateY(random() * Math.PI * 2)
      .translate(Math.cos(a) * r, y, Math.sin(a) * r);
    const tint = GREENS[Math.floor(random() * GREENS.length)]!.clone().multiplyScalar(0.85 + random() * 0.3);
    parts.push(finish(card, () => tint));
  }
  return mergeGeometries(parts)!;
}

/** A broad, pointed leaf blade (Marantaceae), a little cupped. */
function blade(length: number, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.quadraticCurveTo(width, length * 0.45, 0, length); shape.quadraticCurveTo(-width, length * 0.45, 0, 0);
  return new THREE.ShapeGeometry(shape, 4);
}

function plantParts(kind: CongoKind): PlantParts {
  const random = rng(spatialHash(`congo-geometry:${kind}`));
  const merge = (list: THREE.BufferGeometry[]) => mergeGeometries(list)!;
  switch (kind) {
    case 'emergent':
      return { wood: merge([trunk(44, 0.95, 0.5, 0xb7a990, random), ...buttresses(5, 5, 3.4, 0xa89a80, random), ...limbs(5, 37, 9, 0.35, 0x9a8c72, random)]),
        leaves: crown(34, 7, 46, 10, 3, random) };
    case 'canopy':
      return { wood: merge([trunk(28, 0.6, 0.32, 0x8c7c64, random), ...buttresses(3, 2.6, 1.8, 0x7e6f58, random), ...limbs(4, 23, 6, 0.22, 0x7a6a52, random)]),
        leaves: crown(24, 5.5, 30, 6.5, 3.2, random) };
    case 'midstory':
      return { wood: trunk(14, 0.26, 0.14, 0x6e604c, random), leaves: crown(14, 3.4, 14, 3, 3, random) };
    case 'sapling':
      return { wood: trunk(3.6, 0.06, 0.03, 0x5e5240, random), leaves: crown(6, 1.4, 3.2, 0.9, 0.8, random) };
    case 'raphia': {
      // Raphia: a short trunk and long fronds arching out, each a rachis with drooping leaflets.
      const fronds: THREE.BufferGeometry[] = [];
      for (let f = 0; f < 14; f++) {
        const yaw = (f / 14) * Math.PI * 2 + random() * 0.3, lift = 0.5 + random() * 0.5, length = 8.5 + random() * 2;
        const leaflets: THREE.BufferGeometry[] = [];
        for (let k = 1; k <= 18; k++) {
          const t = k / 18, along = t * length, rise = Math.sin(lift) * along - 0.045 * along * along;
          for (const side of [-1, 1]) {
            const leaflet = new THREE.PlaneGeometry(0.16, 1.5 * (1 - t * 0.5)).translate(0, -0.7 * (1 - t * 0.5), 0)
              .rotateX(0.5).rotateZ(side * 1.1).translate(along * Math.cos(lift), rise, 0);
            leaflets.push(leaflet);
          }
        }
        fronds.push(merge(leaflets.map((g) => finish(g, () => GREENS[3]!))).rotateY(yaw).translate(0, 7, 0));
      }
      return { wood: trunk(7, 0.42, 0.34, 0x4f4232, random), blades: merge(fronds) };
    }
    case 'marantaceae': {
      // Broad paddle leaves on long stalks, 1-2.5 m tall: the Congo forest's understory.
      const leaves: THREE.BufferGeometry[] = [], stalks: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 6; k++) {
        const yaw = random() * Math.PI * 2, height = 1 + random() * 1.4, lean = 0.15 + random() * 0.25;
        stalks.push(finish(new THREE.CylinderGeometry(0.012, 0.02, height, 4).translate(0, height / 2, 0).rotateZ(lean).rotateY(yaw), () => new THREE.Color(0x4d6b2a)));
        const tip = new THREE.Vector3(0, height, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), lean).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const tint = GREENS[2 + Math.floor(random() * 3)]!.clone().multiplyScalar(1.1);
        leaves.push(finish(blade(0.9 + random() * 0.4, 0.4).rotateX(-1.1 + random() * 0.4).rotateY(yaw).translate(tip.x, tip.y, tip.z), () => tint));
      }
      return { wood: merge(stalks), blades: merge(leaves) };
    }
    case 'sedge': {
      const blades: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 14; k++) {
        const h = 0.7 + random() * 0.5, tint = new THREE.Color(0x8a9a4a).lerp(new THREE.Color(0x5e7a32), random());
        blades.push(finish(new THREE.PlaneGeometry(0.05, h).translate(0, h / 2, 0).rotateX((random() - 0.5) * 0.6).rotateY(random() * Math.PI)
          .translate((random() - 0.5) * 0.4, 0, (random() - 0.5) * 0.4), () => tint));
      }
      return { blades: merge(blades) };
    }
    case 'log': {
      const moss = new THREE.Color(0x4f5a2e), bark = new THREE.Color(0x5a4a34);
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

/** A cluster of small leaves drawn on a canvas, alpha-cut: the texture every crown card carries. */
function leafTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 256, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = rng(17);
  for (let i = 0; i < 150; i++) {
    const r = Math.sqrt(random()) * size * 0.46, a = random() * Math.PI * 2;
    const x = size / 2 + Math.cos(a) * r, y = size / 2 + Math.sin(a) * r;
    const l = 26 + random() * 22;
    ctx.fillStyle = `hsl(${88 + random() * 30}, ${38 + random() * 25}%, ${l}%)`;
    ctx.beginPath(); ctx.ellipse(x, y, 7 + random() * 7, 3 + random() * 3, random() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let materials: Record<keyof PlantParts, THREE.Material> | null = null;
export function congoPlantMaterials(): Record<keyof PlantParts, THREE.Material> {
  if (materials) return materials;
  const map = leafTexture();
  materials = {
    wood: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    leaves: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide, ...(map ? { map, alphaTest: 0.45 } : {}) }),
    blades: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }),
  };
  return materials;
}
