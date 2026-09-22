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

/** Ground height in metres at a world position, from the patch the position falls in. */
export function makeHeightSampler(patches: readonly PatchView[]): HeightSampler {
  const byCell = new Map<number, number>();
  for (const patch of patches) byCell.set(patch.id, patchHeight(patch));

  return (x, z) => {
    const col = Math.round(x / PATCH_METRES);
    const row = Math.round(z / PATCH_METRES);
    return byCell.get(row * 20 + col) ?? 0;
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

  for (let i = 0; i < position.count; i++) {
    // Vertex (col, row) sits at the corner shared by up to four patches.
    const col = i % (GRID + 1);
    const row = Math.floor(i / (GRID + 1));

    let height = 0;
    let r = 0; let g = 0; let b = 0;
    let n = 0;

    for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const c = col + dc;
      const rw = row + dr;
      if (c < 0 || rw < 0 || c >= GRID || rw >= GRID) continue;
      const patch = byId.get(rw * GRID + c);
      if (patch === undefined) continue;
      height += patchHeight(patch);
      blend.setHex(HABITAT_COLOUR[patch.habitat] ?? 0x556b3f);
      r += blend.r; g += blend.g; b += blend.b;
      n++;
    }

    if (n > 0) {
      position.setY(i, height / n);
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
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
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
      matrix.setPosition(
        centre.x + (random() - 0.5) * PATCH_METRES,
        patchHeight(patch),
        centre.z + (random() - 0.5) * PATCH_METRES,
      );
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
      matrix.setPosition(centre.x + (i - 1) * 70, patchHeight(patch) + 0.6, centre.z + (i - 1) * 50);
      rock.setMatrixAt(r++, matrix);
    }
  }

  let t = 0;
  for (const patch of woodedPatches) {
    const centre = patchCentre(patch.id);
    const base = patchHeight(patch);
    let seed = (patch.id + 7919) * 2246822519;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < TREES_PER_PATCH; i++) {
      const tx = centre.x + (random() - 0.5) * PATCH_METRES * 0.94;
      const tz = centre.z + (random() - 0.5) * PATCH_METRES * 0.94;
      const scale = 0.7 + random() * 0.9;

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
  group.add(ground);
  return group;
}
