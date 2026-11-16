/**
 * Island waterholes as they look in a forest, not blue discs: an irregular shoreline (pools.ts),
 * water darker over the middle and silty in the shallows, a band of bare, trampled mud (photographed) round
 * the edge that fades into the grass, and clumps of reeds along part of the shore.
 * Presentation only: the pool's centre and size are the simulation's water stock (islandPool).
 */
import * as THREE from 'three';
import { congoTexture } from './congoTextures.js';
import { registerWater, waterLook } from './waterLook.js';
import { fromLocal, poolFrame, shoreFactor, type Pool } from './pools.js';

type HeightSampler = (x: number, z: number) => number;

const SEGMENTS = 64;
// Shallows a silty brown-olive, so the textured mud bed under them shows (an olive band read as a rim).
const DEEP = new THREE.Color(0x1d3a35), SHALLOW = new THREE.Color(0x40392a);
const WET_MUD = new THREE.Color(0x3b3024), DRY_MUD = new THREE.Color(0x6c5a40);
/** Tints over the photographed mud: wet darkens it, dry leaves it almost as photographed. */
const WET_TINT = new THREE.Color(0.62, 0.58, 0.52), DRY_TINT = new THREE.Color(0.95, 0.9, 0.84);
/** The bank's mud photograph repeats every this many metres. */
const MUD_TILE_M = 3.2;

/** The pool's water plane: centred, tilted to the slope, turned and stretched to its own frame. */
export function poolPlane(pool: Pool, groundAt: HeightSampler, out = new THREE.Matrix4()): THREE.Matrix4 {
  const { x, z, radius: r } = pool, y = groundAt(x, z);
  const sx = (groundAt(x + r, z) - groundAt(x - r, z)) / (2 * r), sz = (groundAt(x, z + r) - groundAt(x, z - r)) / (2 * r);
  const { turn, stretch } = poolFrame(pool);
  // Lifted just clear of the ground anywhere under the water (or its nominal circle), never buried uphill.
  let lift = 0;
  for (let k = 0; k < 32; k++) {
    const a = k / 32 * Math.PI * 2, edge = shoreFactor(a, pool.seed);
    for (const f of [0.5, 1, edge]) {
      const local = fromLocal(pool, Math.cos(a) * f, Math.sin(a) * f);
      const dx = local.x - x, dz = local.z - z;
      lift = Math.max(lift, groundAt(local.x, local.z) - (y + sx * dx + sz * dz));
      const circle = { dx: Math.cos(a) * r * f, dz: Math.sin(a) * r * f };
      lift = Math.max(lift, groundAt(x + circle.dx, z + circle.dz) - (y + sx * circle.dx + sz * circle.dz));
    }
  }
  const normal = new THREE.Vector3(-sx, 1, -sz).normalize();
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
  const turned = tilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn));
  return out.compose(new THREE.Vector3(x, y + Math.min(lift, 1.5) + 0.04, z), turned,
    new THREE.Vector3(r * stretch, 1, r / stretch));
}

/** A pool's ripples repeat every this many metres (a river's every 24 m: a pool is sheltered, its ripples small). */
const RIPPLE_TILE_M = 7;

function surface(pools: readonly Pool[], groundAt: HeightSampler): THREE.Mesh {
  const positions: number[] = [], colors: number[] = [], index: number[] = [];
  const v = new THREE.Vector3(), c = new THREE.Color(), m = new THREE.Matrix4();
  for (const pool of pools) {
    poolPlane(pool, groundAt, m);
    const base = positions.length / 3;
    v.set(0, 0, 0).applyMatrix4(m); positions.push(v.x, v.y, v.z); colors.push(DEEP.r, DEEP.g, DEEP.b, 0.94);
    for (let k = 0; k < SEGMENTS; k++) {
      const a = k / SEGMENTS * Math.PI * 2, f = shoreFactor(a, pool.seed);
      // Deep over the middle; toward the shore the shallows turn muddy and clear, so the bank shows
      // through and the water meets it without a rim.
      for (const [t, mix, alpha] of [[0.7, 0.35, 0.86], [1, 1, 0.18]] as const) {
        v.set(Math.cos(a) * f * t, 0, Math.sin(a) * f * t).applyMatrix4(m);
        positions.push(v.x, v.y, v.z);
        c.copy(DEEP).lerp(SHALLOW, mix); colors.push(c.r, c.g, c.b, alpha);
      }
    }
    for (let k = 0; k < SEGMENTS; k++) {
      const mid = base + 1 + k * 2, edge = mid + 1, nextMid = base + 1 + ((k + 1) % SEGMENTS) * 2, nextEdge = nextMid + 1;
      index.push(base, nextMid, mid, mid, nextMid, nextEdge, mid, nextEdge, edge);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  const uv = new Float32Array(positions.length / 3 * 2);
  for (let i = 0; i < positions.length / 3; i++) { uv[i * 2] = positions[i * 3]! / RIPPLE_TILE_M; uv[i * 2 + 1] = positions[i * 3 + 2]! / RIPPLE_TILE_M; }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index); geometry.computeVertexNormals();
  // Still forest water: it mirrors the canopy and the sky through slow ripples (waterLook.ts). Under
  // the trees most of what is overhead is leaves, so a pool mirrors half what an open river does.
  const mesh = new THREE.Mesh(geometry, registerWater(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.12, metalness: 0, transparent: true, depthWrite: false, ...waterLook(0.45, 0.22) })));
  mesh.name = 'water-surface'; mesh.renderOrder = 2;
  return mesh;
}

function bank(pools: readonly Pool[], groundAt: HeightSampler): THREE.Mesh {
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], index: number[] = [];
  // A photographed bai floor (trampled mud, puddles, sedge) when it is loaded; plain mud colours otherwise.
  const mud = congoTexture('bai_marsh');
  const wet = mud ? WET_TINT : WET_MUD, dry = mud ? DRY_TINT : DRY_MUD;
  for (const pool of pools) {
    const base = positions.length / 3;
    for (let k = 0; k < SEGMENTS; k++) {
      const a = k / SEGMENTS * Math.PI * 2, f = shoreFactor(a, pool.seed);
      // Wider where animals come down to drink: an uneven trampled band, not a neat ring.
      const outer = f * (1.18 + 0.1 * (Math.sin(a * 3 + (pool.seed ?? 0)) * 0.5 + 0.5)) + 1.2 / pool.radius;
      for (const [t, colour, alpha] of [[0.9, wet, 1], [1.02, wet, 1], [outer / f, dry, 0]] as const) {
        const p = fromLocal(pool, Math.cos(a) * f * t, Math.sin(a) * f * t);
        positions.push(p.x, groundAt(p.x, p.z) + 0.05, p.z);
        colors.push(colour.r, colour.g, colour.b, alpha);
        uvs.push(p.x / MUD_TILE_M, p.z / MUD_TILE_M);
      }
    }
    for (let k = 0; k < SEGMENTS; k++) {
      const row = base + k * 3, next = base + ((k + 1) % SEGMENTS) * 3;
      for (let ring = 0; ring < 2; ring++) {
        const a = row + ring, b = row + ring + 1, c = next + ring, d = next + ring + 1;
        index.push(a, c, b, b, c, d);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, depthWrite: false, roughness: 0.92, ...(mud ? { map: mud } : {}),
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.name = 'water-bank'; mesh.renderOrder = 1;
  return mesh;
}

function reeds(pools: readonly Pool[], groundAt: HeightSampler): THREE.InstancedMesh {
  // A few clumps per pool along part of its shore (more round a bigger pool), each a tight
  // bunch of thin blades: reeds and sedges, not a fence of posts.
  const clumpsOf = (p: Pool) => Math.round(Math.min(6, Math.max(1, p.radius / 4)));
  const BLADES = 18;
  const total = pools.reduce((n, p) => n + clumpsOf(p) * BLADES, 0);
  const mesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.012, 1, 3).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ roughness: 1 }), Math.max(1, total));
  mesh.name = 'water-reeds'; mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), e = new THREE.Euler();
  let i = 0;
  pools.forEach((pool, p) => {
    let seed = ((pool.seed ?? p) * 2654435761) >>> 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < clumpsOf(pool); k++) {
      const a = random() * Math.PI * 2, f = shoreFactor(a, pool.seed) * (0.97 + random() * 0.08);
      const centre = fromLocal(pool, Math.cos(a) * f, Math.sin(a) * f);
      const tall = 0.5 + random() * 0.5;
      for (let b = 0; b < BLADES; b++) {
        const r = Math.sqrt(random()) * 0.35, t = random() * Math.PI * 2;
        const x = centre.x + Math.cos(t) * r, z = centre.z + Math.sin(t) * r;
        e.set((random() - 0.5) * 0.45, random() * Math.PI, (random() - 0.5) * 0.45);
        m.compose(new THREE.Vector3(x, groundAt(x, z) - 0.05, z), q.setFromEuler(e),
          new THREE.Vector3(1, tall * (0.6 + random() * 0.6), 1));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setHSL(0.18 + random() * 0.06, 0.4, 0.16 + random() * 0.08));
        i++;
      }
    }
  });
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Every island pool: one group named 'water', so the terrain swaps and disposes it as one layer. */
export function buildPools(pools: readonly Pool[], groundAt: HeightSampler): THREE.Group {
  const group = new THREE.Group();
  group.name = 'water';
  group.userData.pools = pools.length;
  if (pools.length > 0) group.add(bank(pools, groundAt), surface(pools, groundAt), reeds(pools, groundAt));
  return group;
}
