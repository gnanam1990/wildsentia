"""The dwarf crocodile on a skeleton of its own: a long spine and tail, four sprawled legs.

    Blender -b --python tools/art/rig_crocodile.py -- --mesh croc-tripo.glb --out DwarfCrocodile.glb [--review DIR]

The generated mesh (Tripo, head toward +X) has its landmarks measured from slices through it,
in mesh units: u runs tail tip (0) to snout (1), z is height above the feet, y the distance from
the midline. The hind feet stand at u 0.42-0.53, the forefeet at u 0.68-0.82, splayed out to
|y| 0.17 and 0.12; the head is raised (its underside 0.15-0.18 above the ground). It is built
1.6 m long, a dwarf crocodile's length (docs/2026-10-14-congo-phase-b-research.md [28]).

The skeleton: a root, the hips, three spine bones to the chest, the neck and head; an eight-bone
tail; each leg an upper, a lower and a foot bone, held out to the side as a crocodile's are.
Weights are bone heat on a voxel proxy, as tools/art/rig_big_cat.py does.

Motion is forward kinematics, keyed per frame and baked to plain bone keys:
- Idle: breathing, a slow tail sway and the head lifting a little.
- Walk: the "high walk", diagonal pairs (left hind with right fore), each leg swinging forward
  raised and pushing back planted, the spine and tail swinging side to side against the legs.
- Swim: the legs folded back along the body, the tail sculling in a wave that runs to its tip.
- Eating: the head snatching and shaking.
- Death: the body rolls belly up and the legs fall slack.
Keyframed from descriptions of crocodilian gaits, not motion capture.
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--mesh", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--review", default="")
parser.add_argument("--texture", type=int, default=1024)
args = parser.parse_args(argv)

FPS = 30
LENGTH_M = 1.6
K = LENGTH_M  # mesh units are 1.0 long nose to tail
U0 = 0.5      # the mesh's middle sits at the origin


def P(u, z, y=0.0):
    """Mesh landmark (u, z, y + = left) to Blender metres, head toward -Y."""
    return Vector((y * K, -(u - U0) * K, z * K))


# Measured landmarks (mesh units): the body's mid-height along its length, and each leg's column
# (centroids of the leg's vertices in height bands). The mesh stands with its right foreleg forward.
MID_Z = 0.17
SPINE = [("spine1", (0.50, 0.170), (0.60, 0.176)), ("spine2", (0.60, 0.176), (0.68, 0.175)),
         ("chest", (0.68, 0.175), (0.78, 0.182)), ("neck", (0.78, 0.182), (0.86, 0.195)), ("head", (0.86, 0.195), (0.97, 0.200))]
TAIL = [(0.50, 0.170), (0.44, 0.160), (0.38, 0.155), (0.31, 0.148), (0.24, 0.138), (0.17, 0.127), (0.11, 0.117), (0.06, 0.102), (0.02, 0.080)]
LEGS = {
    # hip/shoulder, knee/elbow, ankle/wrist, toes: (u, z, |y|), per side
    ("hind", "L"): [(0.496, 0.13, 0.060), (0.464, 0.065, 0.108), (0.484, 0.035, 0.117), (0.500, 0.018, 0.124)],
    ("hind", "R"): [(0.479, 0.13, 0.060), (0.458, 0.065, 0.111), (0.473, 0.035, 0.118), (0.498, 0.018, 0.127)],
    ("fore", "L"): [(0.705, 0.14, 0.045), (0.703, 0.065, 0.087), (0.714, 0.035, 0.081), (0.735, 0.018, 0.082)],
    ("fore", "R"): [(0.709, 0.14, 0.045), (0.752, 0.065, 0.086), (0.768, 0.035, 0.079), (0.788, 0.018, 0.082)],
}
LEG_BONES = ["upper", "lower", "foot"]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS


def apply_transforms(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


# ---- The mesh: head toward -Y, 1.6 m long, feet on z = 0 ----------------------------------
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=args.mesh)
imported = [o for o in bpy.data.objects if o not in before]
meshes = [o for o in imported if o.type == "MESH"]
for o in meshes:
    m = o.matrix_world.copy(); o.parent = None; o.matrix_world = m
for o in imported:
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "DwarfCrocodile"
apply_transforms(body)
xs = [v.co.x for v in body.data.vertices]
span = max(xs) - min(xs)
body.rotation_mode = "XYZ"
body.rotation_euler = (0, 0, -math.pi / 2)  # +X (head) to -Y
body.scale = (K / span, K / span, K / span)
apply_transforms(body)
ys = [v.co.y for v in body.data.vertices]
zs = [v.co.z for v in body.data.vertices]
body.location = Vector((0, -(min(ys) + max(ys)) / 2, -min(zs)))
apply_transforms(body)
print(f"MESH length {max(v.co.y for v in body.data.vertices) - min(v.co.y for v in body.data.vertices):.3f} m, height {max(v.co.z for v in body.data.vertices):.3f} m")
for image in bpy.data.images:
    if image.size[0] > args.texture:
        image.scale(args.texture, int(image.size[1] * args.texture / image.size[0]))

# ---- The skeleton --------------------------------------------------------------------------
arm_data = bpy.data.armatures.new("CrocRig")
arm = bpy.data.objects.new("CrocRig", arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones


def add(name, head, tail, parent=None, connect=False, deform=True):
    b = eb.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    b.use_deform = deform
    d = (b.tail - b.head).normalized()
    b.align_roll(Vector((0, -d.z, d.y)) if abs(d.x) < 0.9 else Vector((0, 0, 1)))
    return b


add("root", P(0.50, MID_Z), P(0.50, MID_Z + 0.08), deform=False)
add("hips", P(0.50, MID_Z), P(0.45, 0.162), "root")
prev = "root"
for name, h, t in SPINE:
    add(name, P(*h), P(*t), prev, connect=prev != "root")
    prev = name
prev = "hips"
for i in range(len(TAIL) - 1):
    add(f"tail{i + 1}", P(*TAIL[i]), P(*TAIL[i + 1]), prev, connect=prev != "hips")
    prev = f"tail{i + 1}"
for (leg, side), joints in LEGS.items():
    sign = 1 if side == "L" else -1
    pts = [P(u, z, sign * y) for u, z, y in joints]
    parent = "hips" if leg == "hind" else "chest"
    for i, bone in enumerate(LEG_BONES):
        add(f"{leg}_{bone}.{side}", pts[i], pts[i + 1], parent if i == 0 else f"{leg}_{LEG_BONES[i - 1]}.{side}", connect=i > 0)
bpy.ops.object.mode_set(mode="OBJECT")
bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())


def inside(p):
    loc, normal, _, _ = bvh.find_nearest(p)
    return loc is not None and (p - loc).dot(normal) < 0


outside = [f"{b.name}:{'head' if not inside(b.head_local) else 'tail'}" for b in arm_data.bones
           if b.use_deform and (not inside(b.head_local) or not inside(b.tail_local))]
print(f"BONES {len(arm_data.bones)}; ends outside the body: {outside or 'none'}")

# ---- Skin: distance to each bone's segment ---------------------------------------------------
# Blender's bone heat finds no solution on this mesh (its spiked scutes and thin toes), so each
# vertex is weighted by its distance to the nearest bones (a Gaussian falloff, the three closest
# kept). A leg bone reaches only vertices out on its own side and below the hip, so the flank
# does not follow the leg; the body and tail bones reach everything else.
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.0001)
bpy.ops.object.mode_set(mode="OBJECT")
deform = [b for b in arm_data.bones if b.use_deform]
SIGMA = 0.035 * K


def segment_distance(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length


groups = {b.name: body.vertex_groups.new(name=b.name) for b in deform}
for v in body.data.vertices:
    p = v.co
    scored = []
    for b in deform:
        if b.name.startswith(("hind_", "fore_")):
            side = 1 if b.name.endswith(".L") else -1
            hip = arm_data.bones[b.name.split("_")[0] + "_upper." + b.name[-1]].head_local
            if side * p.x < abs(hip.x) * 0.8 or p.z > hip.z + 0.02 * K:
                continue
        d = segment_distance(p, b.head_local, b.tail_local)
        scored.append((math.exp(-(d / SIGMA) ** 2) + 1e-6 / (d + 1e-3), b.name))
    scored.sort(reverse=True)
    top = scored[:3]
    total = sum(w for w, _ in top)
    for w, name in top:
        groups[name].add([v.index], w / total, "REPLACE")
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_NAME")
print(f"SKIN vertices {len(body.data.vertices)} unweighted {sum(1 for v in body.data.vertices if not v.groups)}")

# ---- Motion helpers ------------------------------------------------------------------------
bones = arm_data.bones
pose = arm.pose.bones


def pitch_up(angle):  # nose up
    return Quaternion((1, 0, 0), -angle)


def yaw_left(angle):
    return Quaternion((0, 0, 1), angle)


def roll_right(angle):  # right side down
    return Quaternion((0, -1, 0), angle)


def set_rot(name, q):
    """A rotation about world axes through the bone's head, written in the bone's rest frame."""
    m = bones[name].matrix_local.to_3x3()
    pose[name].rotation_mode = "QUATERNION"
    pose[name].rotation_quaternion = (m.inverted() @ q.to_matrix() @ m).to_quaternion()


def set_loc(name, world_offset):
    m = bones[name].matrix_local.to_3x3()
    pose[name].location = m.inverted() @ world_offset


def smooth(w):
    w = min(1.0, max(0.0, w))
    return w * w * w * (10 - 15 * w + 6 * w * w)


def reset_pose():
    for pb in pose:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()


def body_wave(phase, spine_deg, tail_deg, travel=0.9):
    """A side-to-side wave along the spine and tail, travelling toward the tail tip."""
    for i, (name, _, _) in enumerate(SPINE[:3]):
        set_rot(name, yaw_left(math.radians(spine_deg) * math.sin(phase - i * 0.4)))
    for i in range(len(TAIL) - 1):
        set_rot(f"tail{i + 1}", yaw_left(math.radians(tail_deg) * (0.5 + i / 8) * math.sin(phase - (i + 2) * travel * 0.5)))


def leg(legname, side, swing, lift=0.0, fold=0.0):
    """swing: + forward (protraction) about the vertical; lift: raise the limb; fold: tuck it back along the body."""
    s = 1 if side == "L" else -1
    upper = yaw_left(s * swing) @ roll_right(-s * lift) @ yaw_left(-s * fold)
    set_rot(f"{legname}_upper.{side}", upper)
    set_rot(f"{legname}_lower.{side}", pitch_up(-0.4 * fold - 0.6 * lift))
    set_rot(f"{legname}_foot.{side}", pitch_up(0.3 * lift))


# ---- Clips -----------------------------------------------------------------------------------
def idle(t):
    p = 2 * math.pi * t
    set_loc("root", Vector((0, 0, 0.004 * math.sin(2 * p))))
    body_wave(p, 1.0, 4.0)
    set_rot("head", pitch_up(math.radians(3) * (0.5 + 0.5 * math.sin(p))))


def walk(t):
    # The high walk: diagonal pairs a half cycle apart, each leg raised and swung forward for
    # 35% of the cycle, planted and pushed back for the rest.
    p = 2 * math.pi * t
    set_loc("root", Vector((0, 0, 0.006 * math.sin(2 * p))))
    body_wave(p, 6.0, 9.0)
    set_rot("neck", yaw_left(math.radians(-4) * math.sin(p)))
    for legname, side, offset in (("hind", "L", 0.0), ("fore", "R", 0.0), ("hind", "R", 0.5), ("fore", "L", 0.5)):
        w = (t + offset) % 1.0
        if w < 0.35:  # swing: raised, moving forward
            a = w / 0.35
            swing = -0.35 + 0.7 * smooth(a)
            lift = math.radians(18) * math.sin(math.pi * a)
        else:  # stance: planted, pushed back
            a = (w - 0.35) / 0.65
            swing = 0.35 - 0.7 * a
            lift = 0.0
        leg(legname, side, swing, lift)


def swim(t):
    # Legs pressed back along the body; the tail sculls in a wave that grows toward its tip.
    p = 2 * math.pi * t
    for legname in ("hind", "fore"):
        for side in ("L", "R"):
            leg(legname, side, -0.2, lift=math.radians(10), fold=math.radians(55))
    body_wave(p, 3.0, 22.0, travel=1.2)
    set_rot("head", pitch_up(math.radians(4)))


def eating(t):
    # Snatch forward and down, then a shake of the head.
    grab = smooth(t / 0.25) * (1 - smooth((t - 0.35) / 0.2))
    shake = math.sin(2 * math.pi * 4 * t) * smooth((t - 0.45) / 0.1) * (1 - smooth((t - 0.85) / 0.15))
    set_rot("neck", pitch_up(math.radians(-12) * grab) @ yaw_left(math.radians(14) * shake))
    set_rot("head", pitch_up(math.radians(-8) * grab) @ roll_right(math.radians(10) * shake))
    for legname in ("hind", "fore"):
        for side in ("L", "R"):
            leg(legname, side, 0.0)


def death(t):
    roll = smooth(t / 0.6)
    slack = smooth((t - 0.3) / 0.4)
    set_loc("root", Vector((0, 0, 0.10 * K * math.sin(math.pi * min(1, roll)) * 0.6)))
    set_rot("root", roll_right(math.radians(165) * roll))
    for legname in ("hind", "fore"):
        for side in ("L", "R"):
            leg(legname, side, 0.1, lift=math.radians(-25) * slack)
    body_wave(0.0, 0.0, 0.0)


CLIPS = [
    ("Idle", idle, 4.0, True),
    ("Walk", walk, 1.6, True),
    ("Swim", swim, 1.4, True),
    ("Eating", eating, 1.6, False),
    ("Death", death, 1.6, False),
]

baked = {}
bpy.context.view_layer.objects.active = arm
for name, fn, seconds, _cyclic in CLIPS:
    frames = max(8, round(seconds * FPS))
    if arm.animation_data:
        arm.animation_data.action = None
    for f in range(frames + 1):
        reset_pose()
        fn(f / frames)
        for pb in pose:
            pb.keyframe_insert("rotation_quaternion", frame=f)
            pb.keyframe_insert("location", frame=f)
    action = arm.animation_data.action
    action.name = name
    action.use_fake_user = True
    baked[name] = (action, frames)
    print(f"CLIP {name}: {frames} frames ({frames / FPS:.2f} s)")

reset_pose()
arm.animation_data.action = None
for name, (action, frames) in baked.items():
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)

out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="WEBP",
                          export_draco_mesh_compression_enable=False, export_apply=False)
print(f"WROTE {out} {out.stat().st_size} bytes")

# ---- Review: side and top filmstrips of every clip ----------------------------------------
if args.review:
    review = Path(args.review)
    review.mkdir(parents=True, exist_ok=True)
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 520, 360
    world = bpy.data.worlds.new("review"); scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.84, 0.82, 1)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3; sun.rotation_euler = (0.8, 0.2, 0.6); scene.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    camera = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"; camera.data.ortho_scale = 2.0
    scene.camera = camera
    views = {"side": Vector((3, 0, 0.3)), "top": Vector((0.01, 0, 3.5)), "three": Vector((2.0, -2.0, 1.2))}
    for name, (action, frames) in baked.items():
        for track in arm.animation_data.nla_tracks:
            track.mute = track.name != name
        for view, at in views.items():
            camera.location = at
            camera.rotation_euler = (Vector((0, 0, 0.2)) - at).to_track_quat("-Z", "Y").to_euler()
            for i in range(4):
                scene.frame_set(round(frames * i / 4))
                scene.render.filepath = str(review / f"{name}-{view}-{i}.png")
                bpy.ops.render.render(write_still=True)
    print("RENDERED")
