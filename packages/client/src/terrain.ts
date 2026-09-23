import * as THREE from 'three';
import { PATCH_METRES, patchCentre } from './space.js';

export interface PatchView {
  id: number;
  x: number;
  y: number;
  habitat: string;
  grass: number;
  browse: number;
  water: number;
  /** 0-1 as the simulation stores it. Scaled to metres for relief. */
  elevation?: number;
  canopyCover?: number;
}

/** Metres of relief across the full 0-1 elevation range the simulation reports. */
const RELIEF_M = 90;
const TREES_PER_PATCH = 14;

export function patchHeight(patch: PatchView): number {
  return (patch.elevation ?? 0.5) * RELIEF_M;
}

export type HeightSampler = (x: number, z: number) => number;

/**
 * Heights of the (GRID+1)² ground-mesh corners: each the average of the patches that meet there.
 * The drawn ground and the height sampler both read these, so they cannot disagree.
 */
function cornerHeights(patches: readonly PatchView[]): { heights: Float64Array; present: Uint8Array } {
  const byId = new Map<number, PatchView>();
  for (const patch of patches) byId.set(patch.id, patch);
  const heights = new Float64Array((GRID + 1) * (GRID + 1));
  const present = new Uint8Array((GRID + 1) * (GRID + 1));
  for (let row = 0; row <= GRID; row++) {
    for (let col = 0; col <= GRID; col++) {
      let sum = 0;
      let n = 0;
      for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= GRID || r >= GRID) continue;
        const patch = byId.get(r * GRID + c);
        if (patch === undefined) continue;
        sum += patchHeight(patch);
        n++;
      }
      const i = row * (GRID + 1) + col;
      heights[i] = n > 0 ? sum / n : 0;
      present[i] = n > 0 ? 1 : 0;
    }
  }
  return { heights, present };
}

/**
 * Ground height in metres at a world position: the surface of the drawn ground mesh itself,
 * interpolated across the same two triangles per cell that three.js builds. It once returned
 * the flat height of the patch a point fell in, and on slopes animals stood metres inside the
 * hillside — a gaur was found 2.6 m underground, invisible.
 */
export function makeHeightSampler(patches: readonly PatchView[]): HeightSampler {
  const { heights } = cornerHeights(patches);
  const at = (col: number, row: number): number => heights[row * (GRID + 1) + col]!;

  return (x, z) => {
    // Corner (col, row) sits at (col·300 − 150, row·300 − 150): the patch centres are cell centres.
    const gx = Math.min(GRID - 1e-9, Math.max(0, (x + PATCH_METRES / 2) / PATCH_METRES));
    const gz = Math.min(GRID - 1e-9, Math.max(0, (z + PATCH_METRES / 2) / PATCH_METRES));
    const col = Math.floor(gx);
    const row = Math.floor(gz);
    const fx = gx - col;
    const fz = gz - row;
    const a = at(col, row);
    const b = at(col, row + 1);
    const c = at(col + 1, row + 1);
    const d = at(col + 1, row);
    // PlaneGeometry splits each cell into triangles (a, b, d) and (b, c, d).
    return fx + fz <= 1
      ? a + (d - a) * fx + (b - a) * fz
      : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
  };
}

const HABITAT_COLOUR: Record<string, number> = {
  grassland: 0x86a552,
  shola:     0x4a6b3f,
  riparian:  0x628d59,
  marsh:     0x5d7553,
  rock:      0x857f72,
  water:     0x2c6b7d,
};

/** Metres. A sambar stands 1.35 m at the shoulder, so grass must be ankle height, not tree height. */
const GRASS_HEIGHT_M = 0.85;
const GRASS_RADIUS_M = 0.14;
const TUFTS_PER_PATCH = 64;

/**
 * Counts what the GPU would have to draw. Every Mesh, InstancedMesh, Points and Line is one
 * call regardless of how much geometry it carries — which is exactly why vegetation is
 * instanced rather than cloned per patch.
 */
export function countDrawCalls(root: THREE.Object3D): number {
  let calls = 0;
  root.traverse((object) => {
    const o = object as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (o.isMesh === true || o.isPoints === true || o.isLine === true) calls++;
  });
  return calls;
}

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  name: string,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
  mesh.name = name;
  mesh.count = count;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Four instanced meshes carry the entire 400-patch world: ground tiles, grass tufts, water
 * planes and rock. That is four draw calls for the terrain, against 400+ if each patch were
 * its own mesh.
 */
const GRID = 20;

/**
 * A single 21x21-vertex plane displaced by the elevation the simulation reports, coloured per
 * vertex by the habitat of the patches meeting at that corner. Corner values average whatever
 * patches touch them, so habitats blend instead of ending at a hard tile edge.
 */
/** Metres one tile of the ground detail texture covers. */
const DETAIL_TILE_M = 6;

/**
 * A small tiling texture of grass blades and soil flecks, generated once and deterministically
 * (no Math.random: the same world looks the same on every screen). Multiplied into the habitat
 * colour, it adds grain without changing the colour the simulation's habitats set.
 */
function groundDetail(): THREE.Texture | null {
  if (typeof document === 'undefined') return null; // tests build terrain without a DOM
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  let seed = 20_260_923;
  const random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  ctx.fillStyle = 'rgb(214,214,214)';
  ctx.fillRect(0, 0, size, size);
  // Soft patches of lighter and darker ground.
  for (let i = 0; i < 90; i++) {
    const shade = 170 + Math.floor(random() * 85);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.35)`;
    ctx.beginPath();
    ctx.arc(random() * size, random() * size, 6 + random() * 22, 0, Math.PI * 2);
    ctx.fill();
  }
  // Blades: short strokes, mostly upright, in lighter and darker greys.
  for (let i = 0; i < 2600; i++) {
    const x = random() * size;
    const y = random() * size;
    const shade = 150 + Math.floor(random() * 105);
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.8)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (random() - 0.5) * 3, y - 2 - random() * 5);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set((GRID * PATCH_METRES) / DETAIL_TILE_M, (GRID * PATCH_METRES) / DETAIL_TILE_M);
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildGroundMesh(patches: readonly PatchView[]): THREE.Mesh {
  const byId = new Map<number, PatchView>();
  for (const patch of patches) byId.set(patch.id, patch);

  const span = GRID * PATCH_METRES;
  const geometry = new THREE.PlaneGeometry(span, span, GRID, GRID).rotateX(-Math.PI / 2);
  geometry.translate(span / 2 - PATCH_METRES / 2, 0, span / 2 - PATCH_METRES / 2);

  const position = geometry.attributes.position!;
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  const blend = new THREE.Color();
  const { heights, present } = cornerHeights(patches);

  for (let i = 0; i < position.count; i++) {
    // Vertex (col, row) sits at the corner shared by up to four patches.
    const col = i % (GRID + 1);
    const row = Math.floor(i / (GRID + 1));

    let r = 0; let g = 0; let b = 0;
    let n = 0;

    for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const c = col + dc;
      const rw = row + dr;
      if (c < 0 || rw < 0 || c >= GRID || rw >= GRID) continue;
      const patch = byId.get(rw * GRID + c);
      if (patch === undefined) continue;
      blend.setHex(HABITAT_COLOUR[patch.habitat] ?? 0x556b3f);
      r += blend.r; g += blend.g; b += blend.b;
      n++;
    }

    if (present[i] === 1) {
      position.setY(i, heights[i]!);
      colour.setRGB(r / n, g / n, b / n);
    } else {
      colour.setHex(0x556b3f);
    }
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
      // The habitat colour, broken up by a fine tiled speckle of blades and soil: a single flat
      // colour across a 300 m patch is what made the ground read as cheap.
      map: groundDetail(),
    }),
  );
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  return mesh;
}

export function buildTerrain(patches: readonly PatchView[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';

  const waterPatches = patches.filter((p) => p.habitat === 'water' || p.water > 20_000);
  const rockPatches = patches.filter((p) => p.habitat === 'rock');
  const tuftsPerPatch = TUFTS_PER_PATCH;
  const grassPatches = patches.filter((p) => p.grass > 100);

  // One continuous heightmap rather than 400 separate tiles. Tiles at differing elevations
  // leave visible gaps along every shared edge; a single displaced mesh has no seams and costs
  // one draw call instead of an instanced batch.
  const ground = buildGroundMesh(patches);
  const grass = instanced(
    new THREE.ConeGeometry(GRASS_RADIUS_M, GRASS_HEIGHT_M, 3).translate(0, GRASS_HEIGHT_M / 2, 0),
    new THREE.MeshStandardMaterial({ color: 0x5f8a3c, roughness: 1, flatShading: true }),
    grassPatches.length * tuftsPerPatch,
    'grass',
  );
  const water = instanced(
    new THREE.PlaneGeometry(PATCH_METRES, PATCH_METRES).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x2f6f86, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85,
    }),
    waterPatches.length,
    'water',
  );
  const rock = instanced(
    new THREE.DodecahedronGeometry(1.6, 0),
    new THREE.MeshStandardMaterial({ color: 0x6d6a60, roughness: 1, flatShading: true }),
    rockPatches.length * 3,
    'rock',
  );

  // Trees go where the simulation reports canopy, not where they would look nice.
  const woodedPatches = patches.filter((p) => (p.canopyCover ?? 0) > 0.3);
  const trunk = instanced(
    new THREE.CylinderGeometry(0.22, 0.4, 7, 6).translate(0, 3.5, 0),
    new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }),
    woodedPatches.length * TREES_PER_PATCH,
    'trunk',
  );
  const canopy = instanced(
    new THREE.IcosahedronGeometry(3.4, 0),
    new THREE.MeshStandardMaterial({ color: 0x3f6b36, roughness: 1, flatShading: true }),
    woodedPatches.length * TREES_PER_PATCH,
    'canopy',
  );
  trunk.castShadow = true;
  canopy.castShadow = true;

  const matrix = new THREE.Matrix4();
  // Everything stands on the drawn surface, not on its patch's average height: on a slope the
  // difference is metres, enough to float grass in the air or bury a tree to its crown.
  const groundAt = makeHeightSampler(patches);

  let g = 0;
  for (const patch of grassPatches) {
    const centre = patchCentre(patch.id);
    const density = Math.min(1, patch.grass / 6000);
    let seed = patch.id * 2654435761;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < tuftsPerPatch; i++) {
      matrix.makeScale(1, 0.5 + density, 1);
      const gx = centre.x + (random() - 0.5) * PATCH_METRES;
      const gz = centre.z + (random() - 0.5) * PATCH_METRES;
      matrix.setPosition(gx, groundAt(gx, gz), gz);
      grass.setMatrixAt(g++, matrix);
    }
  }

  waterPatches.forEach((patch, index) => {
    const centre = patchCentre(patch.id);
    matrix.makeTranslation(centre.x, patchHeight(patch) + 0.4, centre.z);
    water.setMatrixAt(index, matrix);
  });

  let r = 0;
  for (const patch of rockPatches) {
    const centre = patchCentre(patch.id);
    for (let i = 0; i < 3; i++) {
      matrix.makeScale(1 + i * 0.3, 0.7, 1 + i * 0.2);
      const rx = centre.x + (i - 1) * 70;
      const rz = centre.z + (i - 1) * 50;
      matrix.setPosition(rx, groundAt(rx, rz) + 0.6, rz);
      rock.setMatrixAt(r++, matrix);
    }
  }

  let t = 0;
  for (const patch of woodedPatches) {
    const centre = patchCentre(patch.id);
    let seed = (patch.id + 7919) * 2246822519;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < TREES_PER_PATCH; i++) {
      const tx = centre.x + (random() - 0.5) * PATCH_METRES * 0.94;
      const tz = centre.z + (random() - 0.5) * PATCH_METRES * 0.94;
      const scale = 0.7 + random() * 0.9;
      const base = groundAt(tx, tz);

      matrix.makeScale(scale, scale, scale);
      matrix.setPosition(tx, base, tz);
      trunk.setMatrixAt(t, matrix);

      matrix.makeScale(scale, scale * 0.8, scale);
      matrix.setPosition(tx, base + 7 * scale, tz);
      canopy.setMatrixAt(t, matrix);
      t++;
    }
  }

  for (const mesh of [grass, water, rock, trunk, canopy]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  // Kept so the far-field can be hidden near the camera and restored exactly (hideFarFieldNear).
  for (const mesh of [grass, rock, trunk, canopy]) {
    mesh.userData.base = (mesh.instanceMatrix.array as Float32Array).slice();
  }
  group.add(ground);
  return group;
}

const FAR_FIELD = ['grass', 'rock', 'trunk', 'canopy'] as const;

/**
 * The world-wide vegetation is cheap stand-ins: cones and blocks that read as forest from a
 * distance. Where the detailed plants are drawn around the camera, the stand-ins are hidden so
 * the two never overlap; everywhere else they are restored exactly as built.
 */
export function hideFarFieldNear(terrain: THREE.Object3D, focus: { x: number; z: number }, radiusM: number): void {
  for (const name of FAR_FIELD) {
    const mesh = terrain.getObjectByName(name) as THREE.InstancedMesh | undefined;
    const base = mesh?.userData.base as Float32Array | undefined;
    if (mesh === undefined || base === undefined) continue;
    const out = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16;
      const near = Math.hypot(base[o + 12]! - focus.x, base[o + 14]! - focus.z) <= radiusM;
      if (near) out.fill(0, o, o + 16);
      else out.set(base.subarray(o, o + 16), o);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

