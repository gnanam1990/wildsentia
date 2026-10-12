import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The big cats' strides, measured from the GLB itself by forward kinematics: where each paw's tip
 * is, frame by frame. A walk that shuffles (paws never lifted, barely moving) or that pushes a paw
 * through the ground reads as wrong at once, whatever the client does with the clip's rate.
 */
type Q = [number, number, number, number];
type V = [number, number, number];
interface Gltf {
  nodes: Array<{ name?: string; children?: number[]; rotation?: Q; translation?: V; scale?: V }>;
  animations: Array<{ name: string; channels: Array<{ sampler: number; target: { node: number; path: string } }>;
    samplers: Array<{ input: number; output: number }> }>;
  accessors: Array<{ bufferView: number; byteOffset?: number; count: number; type: string }>;
  bufferViews: Array<{ byteOffset?: number }>;
}

function load(file: string) {
  const buffer = readFileSync(new URL(`../public/assets/animals/${file}`, import.meta.url));
  const length = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + length).toString()) as Gltf;
  const bin = buffer.subarray(20 + length + 8);
  const read = (index: number) => {
    const a = gltf.accessors[index]!, size = ({ SCALAR: 1, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type]!;
    const offset = (gltf.bufferViews[a.bufferView]!.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: size }, (_, k) => bin.readFloatLE(offset + (i * size + k) * 4)));
  };
  return { gltf, read };
}

const qmul = (a: Q, b: Q): Q => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
  a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const rotate = (q: Q, v: V): V => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };

/** Each paw tip's height and fore-aft position over one cycle of a clip. */
function paws(file: string, clip: string) {
  const { gltf, read } = load(file);
  const parent = new Map<number, number>();
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const anim = gltf.animations.find((a) => a.name === clip)!;
  const tracks = new Map(anim.channels.map((c) => [`${c.target.node}:${c.target.path}`, read(anim.samplers[c.sampler]!.output)]));
  const frames = read(anim.samplers[0]!.input).length;
  const tip = (node: number, f: number): V => {
    let p: V = [0, 0.12, 0];
    for (let n: number | undefined = node; n !== undefined; n = parent.get(n)) {
      const at = gltf.nodes[n]!, s = at.scale ?? [1, 1, 1];
      const q = (tracks.get(`${n}:rotation`)?.[f] ?? at.rotation ?? [0, 0, 0, 1]) as Q;
      const t = (tracks.get(`${n}:translation`)?.[f] ?? at.translation ?? [0, 0, 0]) as V;
      const r = rotate(q, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
      p = [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
    }
    return p;
  };
  return ['front.1', 'front.-1', 'back.1', 'back.-1'].map((leg) => {
    const node = gltf.nodes.findIndex((n) => n.name === `${leg}.foot`);
    const at = Array.from({ length: frames }, (_, f) => tip(node, f));
    const ys = at.map((p) => p[1]), low = Math.min(...ys), zs = at.map((p) => p[2]);
    return { leg, lowest: low, lift: Math.max(...ys) - low, planted: ys.filter((y) => y < low + 0.02).length / frames,
      sweep: Math.max(...zs) - Math.min(...zs) };
  });
}

describe('the big cats\' strides', () => {
  it.each(['TigerRigged.glb', 'LeopardRigged.glb'])('%s walks: each paw planted most of the stride, swept under the body, lifted between, never through the ground', (file) => {
    for (const paw of paws(file, 'Walk')) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.5);
      expect(paw.planted, paw.leg).toBeLessThan(0.8);
      expect(paw.sweep, paw.leg).toBeGreaterThan(0.45);
      expect(paw.lift, paw.leg).toBeGreaterThan(0.05);
      expect(paw.lowest, paw.leg).toBeGreaterThan(0.055); // the paw tip's resting height is 0.061
    }
  });

  it('trots on diagonal pairs and stalks low, with the same footing', () => {
    for (const paw of paws('TigerRigged.glb', 'Run')) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.3);
      expect(paw.planted, paw.leg).toBeLessThan(0.6);
      expect(paw.lowest, paw.leg).toBeGreaterThan(0.055);
    }
    for (const paw of paws('TigerRigged.glb', 'Sneak')) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.55);
      expect(paw.lowest, paw.leg).toBeGreaterThan(0.055);
    }
  });
});
