/**
 * Big-cat strides for the project's rigged tiger (and the leopard made from it), written into the
 * GLB without Blender. The poses use rig_local_tiger.py's own language (a bone turned about a
 * model-space axis on top of its rest pose); big_cat_pose.mjs's conversion reproduces the script's
 * existing Walk and Gallop to within 0.05°, so these read as if the script had made them.
 *
 *   node big_cat_gaits.mjs IN.glb OUT.glb
 *
 * Walk: the cats' lateral-sequence walk, four beats (hind, fore on one side, then the other), each
 * foot planted for 60% of the stride (its sweep sized to the ground the client's stride rate covers) and sweeping back under the body, lifted, folded and swung
 * forward; hips and shoulders roll, the spine sways, the head is carried low with a nod per step.
 * Run (shown as the trot): diagonal pairs, a longer reach and more lift. Sneak: the stalk, low and
 * slow, legs bent, head down and forward. One stride cycle per clip; the client sets the rate.
 */
import { prune } from '@gltf-transform/functions';
import { open, poser, PI } from './big_cat_pose.mjs';

const [input, output] = process.argv.slice(2);
const rig = await open(input);
const a = poser(rig);
const BONES = ['root', 'hips', 'spine', 'neck', 'head', 'tail0', 'tail1',
  ...['front', 'back'].flatMap((w) => [-1, 1].flatMap((s) => [`${w}.${s}`, `${w}.${s}.lower`, `${w}.${s}.foot`]))];

/** Legs on the ground this frame: their paws are held to the ground after posing (see plant). */
let planted = [], swinging = [];

/** One leg through a stride: planted (u < duty) it sweeps from reaching forward to pushing back. */
function leg(which, side, u, { duty, stance, reach, lift, give, bend = 0 }) {
  const bone = `${which}.${side}`, front = which === 'front';
  if (u < duty) {
    planted.push(bone);
    const k = u / duty, angle = -stance + 2 * stance * k, g = give * Math.sin(PI * k);
    a.pose(bone, [1, 0, 0], angle);
    a.pose(bone + '.lower', [1, 0, 0], (front ? g : -g) + (front ? bend : -bend));
    a.pose(bone + '.foot', [1, 0, 0], -angle * 0.8 + (front ? -bend * 0.6 : bend * 0.9));
  } else {
    const k = (u - duty) / (1 - duty);
    swinging.push({ bone, lift: (front ? 0.06 : 0.05) * Math.sin(PI * k) });
    const angle = stance * Math.cos(PI * k) - reach * Math.sin(PI * k), fold = Math.sin(PI * k) ** 1.4;
    a.pose(bone, [1, 0, 0], angle);
    a.pose(bone + '.lower', [1, 0, 0], (front ? lift : -lift * 0.6) * fold + (front ? bend : -bend));
    a.pose(bone + '.foot', [1, 0, 0], (front ? 0.55 : 0.45) * fold - angle * 0.3 + (front ? -bend * 0.6 : bend * 0.9));
  }
}

function walk(t) {
  const w = 2 * PI * t;
  a.rootOffset(0, 0, 0.012 * Math.cos(2 * w));
  a.pose('root', [1, 0, 0], 0.012 * Math.sin(2 * w + 0.4));
  // The hips drop toward the hind leg that is swinging, the shoulders a quarter-stride later.
  a.pose('hips', [0, 1, 0], 0.05 * Math.sin(w));
  a.pose('spine', [0, 1, 0], -0.04 * Math.sin(w - PI / 2));
  a.pose('spine', [0, 0, 1], 0.035 * Math.sin(w + 0.6));
  // Head carried low and level, nodding once per step.
  a.pose('neck', [1, 0, 0], 0.09 + 0.03 * Math.sin(2 * w + 0.8));
  a.pose('head', [1, 0, 0], -0.05 - 0.025 * Math.sin(2 * w + 0.8));
  a.pose('head', [0, 0, 1], 0.03 * Math.sin(w));
  a.pose('tail0', [0, 0, 1], 0.12 * Math.sin(w));
  a.pose('tail1', [0, 0, 1], 0.18 * Math.sin(w - 0.9));
  for (const [which, side, touchdown] of [['back', -1, 0], ['front', -1, 0.25], ['back', 1, 0.5], ['front', 1, 0.75]]) {
    leg(which, side, ((t - touchdown) % 1 + 1) % 1, { duty: 0.6, stance: which === 'front' ? 0.36 : 0.48, reach: 0.1, lift: 0.95, give: 0.06 });
  }
}

function trot(t) {
  const w = 2 * PI * t;
  a.rootOffset(0, 0, 0.022 * Math.cos(2 * w));
  a.pose('root', [1, 0, 0], 0.015 * Math.sin(2 * w));
  a.pose('hips', [0, 1, 0], 0.035 * Math.sin(w));
  a.pose('spine', [0, 1, 0], -0.035 * Math.sin(w));
  a.pose('neck', [1, 0, 0], 0.04 + 0.03 * Math.sin(2 * w + 0.5));
  a.pose('head', [1, 0, 0], -0.02 - 0.02 * Math.sin(2 * w + 0.5));
  a.pose('tail0', [1, 0, 0], 0.25);
  a.pose('tail0', [0, 0, 1], 0.1 * Math.sin(w));
  a.pose('tail1', [0, 0, 1], 0.16 * Math.sin(w - 0.8));
  for (const [which, side, touchdown] of [['back', -1, 0], ['front', 1, 0], ['back', 1, 0.5], ['front', -1, 0.5]]) {
    leg(which, side, ((t - touchdown) % 1 + 1) % 1, { duty: 0.42, stance: which === 'front' ? 0.45 : 0.54, reach: 0.12, lift: 1.1, give: 0.09 });
  }
}

function sneak(t) {
  const w = 2 * PI * t;
  // Low to the ground, shoulders working, head down and forward on a level line.
  a.rootOffset(0, 0, -0.07 + 0.006 * Math.cos(2 * w));
  a.pose('hips', [0, 1, 0], 0.03 * Math.sin(w));
  a.pose('spine', [0, 1, 0], -0.05 * Math.sin(w - PI / 2));
  a.pose('neck', [1, 0, 0], 0.16);
  a.pose('head', [1, 0, 0], -0.14);
  a.pose('tail0', [1, 0, 0], -0.05);
  a.pose('tail1', [0, 0, 1], 0.1 * Math.sin(w * 2));
  for (const [which, side, touchdown] of [['back', -1, 0], ['front', -1, 0.25], ['back', 1, 0.5], ['front', 1, 0.75]]) {
    leg(which, side, ((t - touchdown) % 1 + 1) % 1, { duty: 0.68, stance: which === 'front' ? 0.2 : 0.5, reach: 0.06, lift: 0.8, give: 0.03, bend: 0.22 });
  }
}

// A planted paw stays on the ground and flat: a leg swinging on a fixed length traces an arc, so
// its knee (or hock) and ankle take up the difference, as a real leg's do. The paw is held by its
// tip and its heel (the ankle) at their resting heights.
const PAW_TIP = [0, 0.12, 0], HEEL = [0, 0, 0];
a.reset();
const REST = new Map(['front', 'back'].flatMap((w) => [-1, 1].map((s) => [`${w}.${s}`,
  { tip: a.pointOf(`${w}.${s}.foot`, PAW_TIP)[1], heel: a.pointOf(`${w}.${s}.foot`, HEEL)[1] }])));
function plant() {
  // A swinging paw only has to clear the ground by its lift (most at mid-swing); one already
  // that high is left as authored.
  const lifts = new Map(swinging.map((s) => [s.bone, s.lift]));
  const clear = swinging.filter(({ bone, lift }) => a.pointOf(bone + '.foot', PAW_TIP)[1] < REST.get(bone).tip + lift
    || a.pointOf(bone + '.foot', HEEL)[1] < REST.get(bone).heel + lift).map((s) => s.bone);
  for (const bone of [...planted, ...clear]) {
    const lower = bone + '.lower', foot = bone + '.foot', lifting = !planted.includes(bone);
    const raise = lifts.get(bone) ?? 0, base = REST.get(bone), rest = { tip: base.tip + raise, heel: base.heel + raise };
    const lowerAxis = a.localAxis(lower, [1, 0, 0]), footAxis = a.localAxis(foot, [1, 0, 0]);
    const below = (y, ground) => (lifting ? Math.max(0, ground - y) : Math.abs(y - ground));
    const miss = () => below(a.pointOf(foot, PAW_TIP)[1], rest.tip) + 0.5 * below(a.pointOf(foot, HEEL)[1], rest.heel);
    // The smallest change that does it: among equal fits, the one nearest the authored pose.
    let best = { d1: 0, d2: 0, off: miss() };
    const better = (off, d1, d2) => off < best.off - 1e-5 || (Math.abs(off - best.off) <= 1e-5 && Math.abs(d1) + Math.abs(d2) < Math.abs(best.d1) + Math.abs(best.d2));
    // Coarse, then fine: knee first, ankle second, each kept within a believable bend.
    for (const [span, step] of [[0.9, 0.06], [0.08, 0.008]]) {
      const c1 = best.d1, c2 = best.d2;
      for (let d1 = c1 - span; d1 <= c1 + span + 1e-9; d1 += step) {
        a.nudge(lower, lowerAxis, d1);
        for (let d2 = c2 - span; d2 <= c2 + span + 1e-9; d2 += step) {
          a.nudge(foot, footAxis, d2);
          const off = miss();
          if (better(off, d1, d2)) best = { d1, d2, off };
          a.nudge(foot, footAxis, -d2);
        }
        a.nudge(lower, lowerAxis, -d1);
      }
    }
    a.nudge(lower, lowerAxis, best.d1);
    a.nudge(foot, footAxis, best.d2);
  }
  planted = []; swinging = [];
}

const doc = rig.doc, buffer = doc.getRoot().listBuffers()[0];
function writeClip(name, seconds, fn) {
  const old = doc.getRoot().listAnimations().find((x) => x.getName() === name);
  if (!old) throw new Error(`no ${name} clip`);
  // Its now-unused samplers and accessors are pruned before writing.
  old.dispose();
  const frames = Math.round(seconds * 24), times = new Float32Array(frames + 1);
  const rot = new Map(BONES.map((b) => [b, new Float32Array((frames + 1) * 4)])), loc = new Float32Array((frames + 1) * 3);
  for (let f = 0; f <= frames; f++) {
    times[f] = f / 24;
    a.reset(); planted = []; swinging = []; fn(f / frames); plant();
    for (const b of BONES) rot.get(b).set(a.rotation(b), f * 4);
    loc.set(a.translation('root'), f * 3);
  }
  const anim = doc.createAnimation(name);
  const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  for (const b of BONES) {
    const out = doc.createAccessor().setType('VEC4').setArray(rot.get(b)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(rig.nodes.get(b)).setTargetPath('rotation').setSampler(sampler));
  }
  const out = doc.createAccessor().setType('VEC3').setArray(loc).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
  anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(rig.nodes.get('root')).setTargetPath('translation').setSampler(sampler));
}
writeClip('Walk', 1.6, walk);
writeClip('Run', 0.8, trot);
writeClip('Sneak', 2.2, sneak);
await doc.transform(prune());
await rig.io.write(output, doc);
console.log(`wrote ${output}: Walk, Run (trot) and Sneak replaced`);
