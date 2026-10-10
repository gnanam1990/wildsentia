// rig_local_tiger.py's pose language in JavaScript, for editing the big cats' GLB clips without
// Blender: each pose turns a bone about a model-space axis, on top of its rest pose. It rebuilds
// the script's own Walk and Gallop to within 0.05 degrees, which is how the conversion was checked.
import { NodeIO } from '@gltf-transform/core';
export const PI = Math.PI;
export const qmul = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
export const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const rotate = (q, v) => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), conj(q)); return [p[0], p[1], p[2]]; };
const axisAngle = (axis, angle) => { const l = Math.hypot(...axis), s = Math.sin(angle / 2) / l; return [axis[0]*s, axis[1]*s, axis[2]*s, Math.cos(angle / 2)]; };
// Blender is Z-up, glTF Y-up: Blender (x, y, z) is glTF (x, z, -y).
const toGltf = ([x, y, z]) => [x, z, -y];

export async function open(path) {
  const io = new NodeIO(); const doc = await io.read(path);
  const nodes = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const parentOf = new Map(); for (const n of nodes.values()) for (const c of n.listChildren()) parentOf.set(c, n);
  const world = (n) => { let q = [0, 0, 0, 1], cur = n; const chain = []; while (cur) { chain.unshift(cur); cur = parentOf.get(cur); } for (const c of chain) q = qmul(q, c.getRotation()); return q; };
  return { io, doc, nodes, parentOf, world };
}

/** A pose context like rig_local_tiger.py's Animal: pose(bone, modelAxis, angle), rootOffset(x, y, z). */
export function poser(rig) {
  const rot = new Map(), loc = new Map();
  return {
    reset() { rot.clear(); loc.clear(); },
    pose(name, axis, angle) {
      const node = rig.nodes.get(name); if (!node) return;
      // The model axis in the bone's own rest frame: its world rest rotation, undone.
      const local = rotate(conj(rig.world(node)), toGltf(axis));
      rot.set(name, qmul(rot.get(name) ?? [0, 0, 0, 1], axisAngle(local, angle)));
    },
    rootOffset(x = 0, y = 0, z = 0) {
      const node = rig.nodes.get('root');
      const parentWorld = rig.parentOf.get(node) ? rig.world(rig.parentOf.get(node)) : [0, 0, 0, 1];
      loc.set('root', rotate(conj(parentWorld), toGltf([x, y, z])));
    },
    rotation(name) { return qmul(rig.nodes.get(name).getRotation(), rot.get(name) ?? [0, 0, 0, 1]); },
    /** A model-space axis in a bone's own rest frame, as pose() turns about it. */
    localAxis(name, axis) { return rotate(conj(rig.world(rig.nodes.get(name))), toGltf(axis)); },
    /** Turns one bone a little more about its own local axis (for the paw-planting correction). */
    nudge(name, localAxis, angle) { rot.set(name, qmul(rot.get(name) ?? [0, 0, 0, 1], axisAngle(localAxis, angle))); },
    /** Where a point fixed in a bone's frame is, in model space, under the current pose. */
    pointOf(name, offset) {
      let p = [...offset, 1];
      for (let n = rig.nodes.get(name); n; n = rig.parentOf.get(n)) {
        const q = this.rotation(n.getName()), t = n.getName() === 'root' ? this.translation('root') : n.getTranslation(), s = n.getScale();
        const v = rotate(q, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
        p = [v[0] + t[0], v[1] + t[1], v[2] + t[2], 1];
      }
      return p.slice(0, 3);
    },
    translation(name) { const r = rig.nodes.get(name).getTranslation(), d = loc.get(name) ?? [0, 0, 0]; return [r[0]+d[0], r[1]+d[1], r[2]+d[2]]; },
  };
}
