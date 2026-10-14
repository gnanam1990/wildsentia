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

/** The big-cat rig's (tools/art/rig_big_cat.py) toes. */
const CAT_RIG = { feet: ['fingers.L', 'fingers.R', 'toes.L', 'toes.R'], tip: 0.05, ground: 0.012 };

/** Each paw tip's height and fore-aft position over one cycle of a clip. */
function paws(file: string, clip: string, rig = CAT_RIG) {
  const { gltf, read } = load(file);
  const parent = new Map<number, number>();
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const anim = gltf.animations.find((a) => a.name === clip)!;
  // The exporter shortens a channel that holds still to its first and last keys, so each channel
  // is sampled at the frame's time, not by index.
  const tracks = new Map(anim.channels.map((c) => [`${c.target.node}:${c.target.path}`,
    { times: read(anim.samplers[c.sampler]!.input).map((t) => t[0]!), values: read(anim.samplers[c.sampler]!.output) }]));
  const clock = anim.channels.map((c) => read(anim.samplers[c.sampler]!.input).map((t) => t[0]!)).reduce((a, b) => (b.length > a.length ? b : a));
  const frames = clock.length;
  const at = (key: string, f: number) => {
    const track = tracks.get(key);
    if (!track) return undefined;
    const t = clock[f]!;
    let i = 0;
    while (i + 1 < track.times.length && Math.abs(track.times[i + 1]! - t) <= Math.abs(track.times[i]! - t)) i++;
    return track.values[i];
  };
  const tip = (node: number, f: number): V => {
    let p: V = [0, rig.tip, 0];
    for (let n: number | undefined = node; n !== undefined; n = parent.get(n)) {
      const node = gltf.nodes[n]!, s = node.scale ?? [1, 1, 1];
      const q = (at(`${n}:rotation`, f) ?? node.rotation ?? [0, 0, 0, 1]) as Q;
      const t = (at(`${n}:translation`, f) ?? node.translation ?? [0, 0, 0]) as V;
      const r = rotate(q, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
      p = [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
    }
    return p;
  };
  return rig.feet.map((leg) => {
    const node = gltf.nodes.findIndex((n) => n.name === leg);
    const path = Array.from({ length: frames }, (_, f) => tip(node, f));
    const ys = path.map((p) => p[1]), low = Math.min(...ys), zs = path.map((p) => p[2]);
    return { leg, lowest: low, lift: Math.max(...ys) - low, planted: ys.filter((y) => y < low + rig.ground).length / frames,
      sweep: Math.max(...zs) - Math.min(...zs) };
  });
}

describe('the big cats\' strides', () => {
  // Both cats' own rig (tools/art/rig_big_cat.py), built 0.65 m tall: paw tips rest about 14 mm up.
  it.each(['AfricanLeopard.glb', 'TigerCat.glb', 'AfricanGoldenCat.glb'])('%s walks on planted paws: a four-beat walk, each paw down most of the stride, lifted clear between', (file) => {
    for (const paw of paws(file, 'Walk', CAT_RIG)) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.5);
      expect(paw.planted, paw.leg).toBeLessThan(0.8);
      expect(paw.sweep, paw.leg).toBeGreaterThan(0.35);
      expect(paw.lift, paw.leg).toBeGreaterThan(0.04);
      expect(paw.lowest, paw.leg).toBeGreaterThan(-0.005);
    }
  });
  it.each(['AfricanLeopard.glb', 'TigerCat.glb', 'AfricanGoldenCat.glb'])('%s trots, gallops with long flights between footfalls, and stalks low, never through the ground', (file) => {
    for (const paw of paws(file, 'Run', CAT_RIG)) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.3);
      expect(paw.planted, paw.leg).toBeLessThan(0.6);
      expect(paw.lowest, paw.leg).toBeGreaterThan(-0.005);
    }
    for (const paw of paws(file, 'Gallop', CAT_RIG)) {
      expect(paw.planted, paw.leg).toBeLessThan(0.45);
      expect(paw.lift, paw.leg).toBeGreaterThan(0.08);
      expect(paw.lowest, paw.leg).toBeGreaterThan(-0.005);
    }
    for (const paw of paws(file, 'Sneak', CAT_RIG)) {
      expect(paw.planted, paw.leg).toBeGreaterThan(0.6);
      expect(paw.lowest, paw.leg).toBeGreaterThan(-0.005);
    }
  });
});
