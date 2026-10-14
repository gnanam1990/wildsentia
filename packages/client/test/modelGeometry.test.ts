import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { visualForAnimal } from '../src/species.js';

interface GltfNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }

/** Every mesh vertex of a GLB in its file's rest placement (node transforms applied). */
function restPoints(file: string): THREE.Vector3[] {
  const bytes = readFileSync(new URL(`../public${file}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binStart = 28 + jsonLength;
  const nodes = doc.nodes as GltfNode[];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const local = (n: GltfNode) => n.matrix ? new THREE.Matrix4().fromArray(n.matrix)
    : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
  const world = (i: number): THREE.Matrix4 => parent.has(i) ? world(parent.get(i)!).multiply(local(nodes[i]!)) : local(nodes[i]!);
  const points: THREE.Vector3[] = [];
  nodes.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const m = world(i);
    for (const primitive of doc.meshes[node.mesh].primitives) {
      const accessor = doc.accessors[primitive.attributes.POSITION];
      const view = doc.bufferViews[accessor.bufferView];
      const start = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? 12;
      for (let k = 0; k < accessor.count; k++) {
        const p = new THREE.Vector3(bytes.readFloatLE(start + k * stride), bytes.readFloatLE(start + k * stride + 4),
          bytes.readFloatLE(start + k * stride + 8)).applyMatrix4(m);
        points.push(p);
      }
    }
  });
  return points;
}

const restFootprint = (file: string): Array<[number, number]> => restPoints(file).map((p) => [p.x, p.z]);

/** Separate patches of the model resting on the ground: its feet, hands and anything else that reaches down. */
function groundContacts(file: string): number {
  const points = restPoints(file);
  const bottom = Math.min(...points.map((p) => p.y)), height = Math.max(...points.map((p) => p.y)) - bottom;
  const low = points.filter((p) => p.y < bottom + height * 0.05);
  const join = height * 0.05, label = new Array<number>(low.length).fill(-1);
  let patches = 0, next = 0;
  for (let i = 0; i < low.length; i++) {
    if (label[i] !== -1) continue;
    label[i] = next; const stack = [i]; let size = 0;
    while (stack.length) {
      const a = low[stack.pop()!]!; size++;
      for (let j = 0; j < low.length; j++) if (label[j] === -1 && Math.hypot(low[j]!.x - a.x, low[j]!.z - a.z) < join) { label[j] = next; stack.push(j); }
    }
    next++;
    // A few stray low vertices are not a foot.
    if (size >= 20) patches++;
  }
  return patches;
}

/** Angle, in degrees from +z, of the long axis of a footprint once turned by `yaw` (folded to ±90). */
function longAxisDeg(points: Array<[number, number]>, yaw: number): number {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const turned = points.map(([x, z]) => [x * c + z * s, -x * s + z * c] as const);
  const mx = turned.reduce((a, p) => a + p[0], 0) / turned.length, mz = turned.reduce((a, p) => a + p[1], 0) / turned.length;
  let xx = 0, zz = 0, xz = 0;
  for (const [x, z] of turned) { xx += (x - mx) ** 2; zz += (z - mz) ** 2; xz += (x - mx) * (z - mz); }
  const angle = 0.5 * Math.atan2(2 * xz, zz - xx) * 180 / Math.PI;
  return angle;
}

describe('model heading', () => {
  it.each([
    ['adult male', { speciesId: 'elephant', sex: 'male', lifeStage: 'adult' }],
    ['adult female', { speciesId: 'elephant', sex: 'female', lifeStage: 'adult' }],
    ['calf', { speciesId: 'elephant', sex: 'female', lifeStage: 'juvenile' }],
  ] as const)('turns the Asian elephant %s to walk along its path, not crabwise', (_, animal) => {
    const model = visualForAnimal(animal).model!;
    const points = restFootprint(model.file);
    // The export itself sits about 30 degrees off its forward axis; a plain half turn left it there.
    expect(Math.abs(longAxisDeg(points, Math.PI))).toBeGreaterThan(25);
    expect(Math.abs(longAxisDeg(points, model.yaw ?? 0))).toBeLessThan(3);
  });
});

describe('model anatomy', () => {
  it('stands the grey langur on four limbs; the generated mesh grew a fifth under its chest', () => {
    expect(groundContacts('/assets/animals/GreyLangur.glb')).toBe(4);
  });
  it.each(['GiantSquirrel', 'Chital', 'ChitalHind', 'Sambar', 'Gaur', 'WildBoar', 'Dhole', 'Jackal', 'TigerCat', 'AfricanLeopard', 'BlueDuiker', 'WaterChevrotain',
    'BayDuiker', 'PetersDuiker', 'RedRiverHog', 'ForestBuffalo', 'Sitatunga', 'AfricanGoldenCat'])(
    'stands %s on exactly four limbs', (name) => {
      expect(groundContacts(`/assets/animals/${name}.glb`)).toBe(4);
    });
});
