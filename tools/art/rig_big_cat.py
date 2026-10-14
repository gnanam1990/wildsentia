"""A big cat (the leopard, the tiger) on a skeleton of its own, with gaits driven by planted paws.

    Blender -b --python tools/art/rig_big_cat.py -- --species leopard \
        --mesh leopard-tripo.glb --out AfricanLeopard.glb [--review DIR] [--texture 1024]
    Blender -b --python tools/art/rig_big_cat.py -- --species tiger \
        --mesh packages/client/public/assets/animals/Tiger.glb --out TigerCat.glb

Each species' generated mesh has its joints measured from slices through it (leg columns, body
midline, tail line), listed below in mesh units: u runs tail tip (0) to nose (1), z is height
above the paws, |y| the distance from the midline. Every cat is built 0.65 m tall; the client
scales a model to its species' height, and strides designed by Froude number at one size hold at
any (λ/h depends on Fr alone), so paws stay planted at the tiger's size too. Strides are designed
against the client's stride length (packages/client/src/gait.ts: λ = 2.3 h Fr^0.3, h = 0.85 × height).

The skeleton: a root, pelvis, four spine bones, two neck bones and the head; a nine-bone tail;
each foreleg a shoulder blade, upper arm, forearm, hand and toes; each hind leg a thigh, shin,
foot and toes. Weights are bone heat on a voxel proxy (as tools/art/bind_to_rig.py does).

Motion: each paw follows a stride (planted and sweeping back at the ground's speed, heel lifting,
then folded and swung forward), solved with two-bone IK to the wrist or hock, the hand and foot
aimed at the paw and the toes at the toe tip. The body adds what a cat does: shoulder blades that
rise over the leg in stance and swing with it, a rolling pelvis, a bob, spine flexion in the
gallop, a counter-swinging tail. Every clip is baked to plain bone keys; no constraint ships.
Keyframed motion designed from big-cat locomotion, not motion capture.
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
parser.add_argument("--species", choices=["leopard", "tiger"], default="leopard")
parser.add_argument("--mesh", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--review", default="")
parser.add_argument("--texture", type=int, default=1024)
parser.add_argument("--clips", default="")
parser.add_argument("--debug", default="")
args = parser.parse_args(argv)

FPS = 30
# ---- Measured joints, per species ----------------------------------------------------------
# turn: the rotation about Z that brings the mesh's head to -Y. time: natural clip lengths scale
# with the square root of size (the client sets the rate from speed in any case).
SPECIES = {
    # The Congo's generated leopard (docs/art-review/congo-2026-10-14): a walking stance, head +X.
    "leopard": dict(
        mesh_h=0.556, u0=0.57, turn=-math.pi / 2, time=1.0, name="AfricanLeopard",
        root=((0.50, 0.33), (0.60, 0.33)), hips=(0.33, 0.40),
        spine=[("spine1", (0.33, 0.40), (0.45, 0.39)), ("spine2", (0.45, 0.39), (0.57, 0.385)),
               ("spine3", (0.57, 0.385), (0.68, 0.40)), ("chest", (0.68, 0.40), (0.78, 0.44)),
               ("neck1", (0.78, 0.44), (0.845, 0.46)), ("neck2", (0.845, 0.46), (0.89, 0.47)),
               ("head", (0.89, 0.47), (0.995, 0.425))],
        tail=[(0.235, 0.39), (0.212, 0.32), (0.200, 0.255), (0.188, 0.195), (0.168, 0.14),
              (0.140, 0.10), (0.105, 0.077), (0.068, 0.064), (0.03, 0.075), (0.004, 0.09)],
        # Each leg's joints, root to toe tip: (u, z, |y|).
        legs={
            "hind.L": [(0.29, 0.375, 0.055), (0.335, 0.235, 0.06), (0.25, 0.12, 0.058), (0.285, 0.025, 0.06), (0.33, 0.012, 0.06)],
            "hind.R": [(0.29, 0.375, 0.055), (0.385, 0.25, 0.06), (0.35, 0.105, 0.056), (0.43, 0.025, 0.06), (0.47, 0.012, 0.06)],
            "fore.L": [(0.755, 0.47, 0.035), (0.80, 0.37, 0.06), (0.675, 0.255, 0.06), (0.705, 0.085, 0.055), (0.738, 0.025, 0.058), (0.775, 0.012, 0.058)],
            "fore.R": [(0.78, 0.47, 0.035), (0.83, 0.39, 0.042), (0.765, 0.27, 0.058), (0.782, 0.085, 0.052), (0.82, 0.025, 0.055), (0.862, 0.012, 0.055)],
        }),
    # The island's generated tiger (animals/Tiger.glb, unrigged): standing square, head +Y.
    "tiger": dict(
        mesh_h=0.642, u0=0.52, turn=math.pi, time=math.sqrt(1.0 / 0.65), name="TigerCat",
        root=((0.50, 0.38), (0.60, 0.38)), hips=(0.30, 0.44),
        spine=[("spine1", (0.30, 0.44), (0.42, 0.44)), ("spine2", (0.42, 0.44), (0.54, 0.43)),
               ("spine3", (0.54, 0.43), (0.66, 0.45)), ("chest", (0.66, 0.45), (0.76, 0.50)),
               ("neck1", (0.76, 0.50), (0.83, 0.53)), ("neck2", (0.83, 0.53), (0.875, 0.535)),
               ("head", (0.875, 0.535), (0.995, 0.48))],
        tail=[(0.18, 0.44), (0.165, 0.37), (0.152, 0.30), (0.142, 0.235), (0.13, 0.175),
              (0.11, 0.125), (0.08, 0.098), (0.05, 0.085), (0.02, 0.095), (0.003, 0.12)],
        legs={
            "hind.L": [(0.27, 0.43, 0.08), (0.325, 0.29, 0.09), (0.24, 0.13, 0.11), (0.285, 0.03, 0.145), (0.325, 0.014, 0.145)],
            "hind.R": [(0.27, 0.43, 0.08), (0.325, 0.29, 0.09), (0.24, 0.13, 0.11), (0.285, 0.03, 0.145), (0.325, 0.014, 0.145)],
            "fore.L": [(0.70, 0.55, 0.05), (0.77, 0.42, 0.085), (0.665, 0.29, 0.075), (0.72, 0.09, 0.087), (0.755, 0.03, 0.10), (0.795, 0.014, 0.10)],
            "fore.R": [(0.70, 0.55, 0.05), (0.77, 0.42, 0.085), (0.665, 0.29, 0.075), (0.72, 0.09, 0.087), (0.755, 0.03, 0.10), (0.795, 0.014, 0.10)],
        }),
}
CAT = SPECIES[args.species]
MESH_H = CAT["mesh_h"]
K = 0.65 / MESH_H
U0 = CAT["u0"]  # mid-way between the paws: the model's origin along its length


def P(u, z, y=0.0):
    """Mesh landmark (u, z, signed |y|, + = left) to Blender metres, head toward -Y."""
    return Vector((y * K, -(u - U0) * K, z * K))


SPINE, TAIL, LEGS = CAT["spine"], CAT["tail"], CAT["legs"]
HIND_BONES = ["thigh", "shin", "foot", "toes"]
FORE_BONES = ["scapula", "upperarm", "forearm", "hand", "fingers"]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS


def apply_transforms(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


# ---- The mesh: head toward -Y, 0.65 m tall, paws on z = 0 ---------------------------------
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
body.name = CAT["name"]
apply_transforms(body)
body.rotation_mode = "XYZ"
body.rotation_euler = (0, 0, CAT["turn"])
body.scale = (K, K, K)
apply_transforms(body)
zs = [v.co.z for v in body.data.vertices]
xs = [v.co.y for v in body.data.vertices]
body.location = Vector((0, (U0 - 0.5) * K - (min(xs) + max(xs)) / 2 + 0.0, -min(zs)))
apply_transforms(body)
# Half the torso's width: how high the body lies when it is down on its side.
TORSO_HALF = max(abs(v.co.x) for v in body.data.vertices if abs(v.co.y) < 0.15 and v.co.z > 0.2)
print(f"MESH torso half-width {TORSO_HALF:.3f} m")
print(f"MESH height {max(v.co.z for v in body.data.vertices):.3f} m, length {max(v.co.y for v in body.data.vertices) - min(v.co.y for v in body.data.vertices):.3f} m")
for image in bpy.data.images:
    if image.size[0] > args.texture:
        image.scale(args.texture, int(image.size[1] * args.texture / image.size[0]))

# Every joint should lie inside the body: count crossings of a ray to the side.
bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())


def inside(p):
    loc, normal, _, _ = bvh.find_nearest(p)
    return loc is not None and (p - loc).dot(normal) < 0


# ---- The skeleton --------------------------------------------------------------------------
arm_data = bpy.data.armatures.new("CatRig")
arm = bpy.data.objects.new("CatRig", arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones


def sagittal_roll(bone):
    """Z axis perpendicular to the bone in its own side plane, so X is always the left side."""
    d = (bone.tail - bone.head).normalized()
    bone.align_roll(Vector((0, -d.z, d.y)) if abs(d.x) < 0.9 else Vector((0, 0, 1)))


def add(name, head, tail, parent=None, connect=False, deform=True):
    b = eb.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = eb[parent]
        b.use_connect = connect
    b.use_deform = deform
    sagittal_roll(b)
    return b


add("root", P(*CAT["root"][0]), P(*CAT["root"][1]), deform=False)
add("hips", P(*CAT["hips"]), P(*TAIL[0]), "root")
prev = "root"
for name, h, t in SPINE:
    add(name, P(*h), P(*t), prev, connect=prev != "root")
    prev = name
prev = "hips"
for i in range(len(TAIL) - 1):
    add(f"tail{i + 1}", P(*TAIL[i]), P(*TAIL[i + 1]), prev, connect=True)
    prev = f"tail{i + 1}"
for leg, joints in LEGS.items():
    side = 1 if leg.endswith(".L") else -1
    names = HIND_BONES if leg.startswith("hind") else FORE_BONES
    parent = "hips" if leg.startswith("hind") else "chest"
    points = [P(u, z, side * y) for u, z, y in joints]
    for i, bone in enumerate(names):
        add(f"{bone}.{leg[-1]}", points[i], points[i + 1], parent if i == 0 else f"{names[i - 1]}.{leg[-1]}", connect=i > 0)
bpy.ops.object.mode_set(mode="OBJECT")
outside = [b.name for b in arm_data.bones if b.use_deform and not inside(b.head_local)]
print(f"BONES {len(arm_data.bones)}; heads outside the body: {outside or 'none'}")

# ---- Skin: bone heat on a voxel proxy, copied to the surface -------------------------------
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=0.0001)
bpy.ops.object.mode_set(mode="OBJECT")
proxy = body.copy()
proxy.data = body.data.copy()
proxy.name = "WeightProxy"
scene.collection.objects.link(proxy)
remesh = proxy.modifiers.new("remesh", "REMESH")
remesh.mode = "VOXEL"
remesh.voxel_size = 1.2 / 180
bpy.context.view_layer.objects.active = proxy
bpy.ops.object.modifier_apply(modifier=remesh.name)
# Bone heat fails on small models (its solver's tolerances assume larger scenes): weight a copy
# ten times the size, then bring the proxy back to scale.
heat_rig = arm.copy()
heat_rig.data = arm.data.copy()
scene.collection.objects.link(heat_rig)
for o in (heat_rig, proxy):
    o.scale = (10, 10, 10)
    apply_transforms(o)
bpy.ops.object.select_all(action="DESELECT")
proxy.select_set(True)
heat_rig.select_set(True)
bpy.context.view_layer.objects.active = heat_rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
print(f"SKIN proxy vertices {len(proxy.data.vertices)} unweighted {sum(1 for v in proxy.data.vertices if not v.groups)}")
proxy.modifiers.clear()
proxy.parent = None
proxy.matrix_world = Matrix.Identity(4)
for v in proxy.data.vertices:
    v.co *= 0.1
bpy.data.objects.remove(heat_rig, do_unlink=True)
for group in proxy.vertex_groups:
    body.vertex_groups.new(name=group.name)
transfer = body.modifiers.new("weights", "DATA_TRANSFER")
transfer.object = proxy
transfer.use_vert_data = True
transfer.data_types_verts = {"VGROUP_WEIGHTS"}
transfer.vert_mapping = "POLYINTERP_NEAREST"
transfer.layers_vgroup_select_src = "ALL"
transfer.layers_vgroup_select_dst = "NAME"
bpy.context.view_layer.objects.active = body
bpy.ops.object.modifier_apply(modifier=transfer.name)
bpy.data.objects.remove(proxy, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_NAME")
weighted = [v for v in body.data.vertices if v.groups]
if len(weighted) < len(body.data.vertices):
    tree = KDTree(len(weighted))
    for i, v in enumerate(weighted):
        tree.insert(v.co, i)
    tree.balance()
    for v in [v for v in body.data.vertices if not v.groups]:
        _, n, _ = tree.find(v.co)
        for g in weighted[n].groups:
            body.vertex_groups[g.group].add([v.index], g.weight, "REPLACE")
print(f"SKIN vertices {len(body.data.vertices)} unweighted {sum(1 for v in body.data.vertices if not v.groups)}")

# ---- Controls: IK to wrist and hock, hands and feet aimed at the paw -----------------------
bones = arm_data.bones
pose = arm.pose.bones
LEG_KEYS = ["hind.L", "hind.R", "fore.L", "fore.R"]


def chain(leg):
    s = leg[-1]
    return ([f"thigh.{s}", f"shin.{s}", f"foot.{s}", f"toes.{s}"] if leg.startswith("hind")
            else [f"upperarm.{s}", f"forearm.{s}", f"hand.{s}", f"fingers.{s}"])


def empty(name, at, parent_bone=None):
    e = bpy.data.objects.new(name, None)
    scene.collection.objects.link(e)
    e.empty_display_size = 0.03
    e.location = at
    if parent_bone:
        e.parent = arm
        e.parent_type = "BONE"
        e.parent_bone = parent_bone
        bpy.context.view_layer.update()
        e.matrix_world = Matrix.Translation(at)
    return e


controls = {}
GEOM = {}
for leg in LEG_KEYS:
    upper, lower, hand, toes = chain(leg)
    wrist = bones[hand].head_local.copy()
    ball = bones[toes].head_local.copy()
    tip = bones[toes].tail_local.copy()
    joint = bones[lower].head_local.copy()
    fore = leg.startswith("fore")
    pole_at = joint + Vector((0, 0.45 if fore else -0.45, 0))
    controls[leg] = {
        "ik": empty(f"ik.{leg}", wrist), "ball": empty(f"ball.{leg}", ball), "tip": empty(f"tip.{leg}", tip),
        "pole": empty(f"pole.{leg}", pole_at, "root"),
    }
    c = pose[lower].constraints.new("IK")
    c.target = controls[leg]["ik"]
    c.pole_target = controls[leg]["pole"]
    c.chain_count = 2
    c.use_stretch = False
    d = pose[hand].constraints.new("DAMPED_TRACK")
    d.target = controls[leg]["ball"]
    t = pose[toes].constraints.new("DAMPED_TRACK")
    t.target = controls[leg]["tip"]
    meta = wrist - ball
    toe = tip - ball
    GEOM[leg] = {
        "meta_len": meta.length, "theta0": math.atan2(-meta.y, meta.z),  # ball→wrist from vertical, + = forward
        "toe_len": toe.length, "gamma0": math.atan2(toe.z, -toe.y),      # ball→tip from horizontal, + = up
        "reach": bones[upper].length + bones[lower].length,
        "root": bones[upper].head_local.copy(),
        "side": 1 if leg.endswith(".L") else -1,
    }

# The pole angle that keeps each knee and elbow where the mesh has it.
bpy.context.view_layer.update()
for leg in LEG_KEYS:
    lower = chain(leg)[1]
    rest_joint = bones[lower].head_local.copy()
    best = None
    for degrees in (0, 90, -90, 180):
        pose[lower].constraints["IK"].pole_angle = math.radians(degrees)
        bpy.context.view_layer.update()
        error = (pose[lower].head - rest_joint).length
        if best is None or error < best[0]:
            best = (error, degrees)
    pose[lower].constraints["IK"].pole_angle = math.radians(best[1])
    print(f"POLE {leg} {best[1]}° (rest joint error {best[0] * 1000:.1f} mm)")


# ---- Motion helpers: world axes, semantic rotations ----------------------------------------
def V(x, a, z):
    """Lateral x (+ left), forward a, up z → Blender."""
    return Vector((x, -a, z))


def q_world(axis, angle):
    return Quaternion(axis, angle)


def pitch_up(angle):  # nose up
    return q_world((1, 0, 0), -angle)


def yaw_left(angle):
    return q_world((0, 0, 1), angle)


def roll_right(angle):  # right side down
    return q_world((0, -1, 0), angle)


ROT = {}
LOC = {}


def set_rot(name, q):
    """A rotation about world axes through the bone's head, written in the bone's rest frame."""
    ROT[name] = q
    m = bones[name].matrix_local.to_3x3()
    pose[name].rotation_mode = "QUATERNION"
    pose[name].rotation_quaternion = (m.inverted() @ q.to_matrix() @ m).to_quaternion()


def set_loc(name, world_offset):
    LOC[name] = world_offset
    m = bones[name].matrix_local.to_3x3()
    pose[name].location = m.inverted() @ world_offset


def smooth(w):  # minimum jerk
    w = min(1.0, max(0.0, w))
    return w * w * w * (10 - 15 * w + 6 * w * w)


def bump(w, peak, end):
    """0 at w=0, 1 at peak, back to 0 at end, smooth."""
    if w <= 0 or w >= end:
        return 0.0
    return math.sin(math.pi / 2 * w / peak) ** 2 if w < peak else math.cos(math.pi / 2 * (w - peak) / (end - peak)) ** 2


def rot2(v, angle):
    """Rotate (a, z) counter-clockwise (forward toward up)."""
    c, s = math.cos(angle), math.sin(angle)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)


BALL_Z = {leg: GEOM[leg]["root"].z * 0 + bones[chain(leg)[3]].head_local.z for leg in LEG_KEYS}
TIP_Z = {leg: bones[chain(leg)[3]].tail_local.z for leg in LEG_KEYS}
HIP_A = -GEOM["hind.L"]["root"].y
SHOULDER_A = -(GEOM["fore.L"]["root"].y + GEOM["fore.R"]["root"].y) / 2


def paw(leg, x, a, lift=0.0, theta=None, gamma=None, heel=0.0):
    """Paw targets from the ball's place: wrist/hock (IK), ball, toe tip.
    theta: ball→wrist angle from vertical (+ forward); gamma: toe angle (+ up); heel: toe-off pivot."""
    g = GEOM[leg]
    theta = g["theta0"] if theta is None else theta
    gamma = g["gamma0"] if gamma is None else gamma
    ball = (a, BALL_Z[leg] + lift)
    if heel > 0:
        # Pivot about the planted toe tip (where it rests in stance): the ball and all above rise.
        tip = (a + g["toe_len"] * math.cos(g["gamma0"]), BALL_Z[leg] + g["toe_len"] * math.sin(g["gamma0"]))
        ball = (tip[0] - g["toe_len"] * math.cos(g["gamma0"] - heel), tip[1] - g["toe_len"] * math.sin(g["gamma0"] - heel))
        gamma = g["gamma0"] - heel
    tip = (ball[0] + g["toe_len"] * math.cos(gamma), ball[1] + g["toe_len"] * math.sin(gamma))
    wrist = (ball[0] + g["meta_len"] * math.sin(theta), ball[1] + g["meta_len"] * math.cos(theta))
    return V(x, *wrist), V(x, *ball), V(x, *tip)


def stride(leg, u, gait):
    """One leg through its stride at cycle position u: planted and sweeping back, toe-off,
    folded and swung forward, reaching to land."""
    g, fore = GEOM[leg], leg.startswith("fore")
    d, S = gait["duty"], gait["sweep"]
    a_n = (SHOULDER_A + gait["fore_offset"]) if fore else (HIP_A + gait["hind_offset"])
    x = g["side"] * (gait["fore_width"] if fore else gait["hind_width"])
    roll = math.radians(gait["fore_roll"] if fore else gait["hind_roll"])
    heel_from, heel_max = gait["heel_from"], math.radians(gait["heel"])
    if u < d:
        s = u / d
        a = a_n + S / 2 - S * s
        theta = g["theta0"] + roll * (s - 0.5)
        heel = heel_max * smooth((s - heel_from) / (1 - heel_from)) if s > heel_from else 0.0
        return paw(leg, x, a, theta=theta, heel=heel)
    w = (u - d) / (1 - d)
    start, end = a_n - S / 2 - gait["liftoff_back"], a_n + S / 2
    a = start + (end - start) * smooth(w)
    arc = gait["fore_lift" if fore else "hind_lift"] * math.sin(math.pi * min(1.0, w ** 0.85)) ** 1.1
    lift = arc + (0.012 * (1 - smooth(w / 0.25)) if w < 0.25 else 0.0)
    theta_off = g["theta0"] + roll * 0.5
    if fore:
        # The wrist folds: the paw tucks back and up, then opens and reaches to land.
        flex = math.radians(gait["fore_flex"])
        theta = theta_off + (flex - theta_off + g["theta0"]) * bump(w, 0.35, 0.85) * 1.0
        theta += (g["theta0"] - theta_off) * smooth(w / 0.85) - math.radians(6) * bump(w, 0.85, 1.0)
        gamma = g["gamma0"] - math.radians(35) * bump(w, 0.3, 0.9)
    else:
        # The hock flexes: the paw trails, then swings through under the body.
        flex = math.radians(gait["hind_flex"])
        theta = theta_off + flex * bump(w, 0.25, 0.75) + (g["theta0"] - theta_off) * smooth(w / 0.9) - math.radians(8) * bump(w, 0.7, 1.0)
        gamma = g["gamma0"] - math.radians(30) * bump(w, 0.25, 0.85)
    wrist, ball, tip = paw(leg, x, a, lift=lift, theta=theta, gamma=gamma)
    # A folded paw must not drag its toes: lift the whole paw until its lowest point clears.
    clear = BALL_Z[leg] + g["toe_len"] * math.sin(g["gamma0"]) + 0.5 * arc
    low = min(ball.z, tip.z)
    if low < clear:
        up = Vector((0, 0, clear - low))
        wrist, ball, tip = wrist + up, ball + up, tip + up
    return wrist, ball, tip


TAIL_BONES = [f"tail{i + 1}" for i in range(len(TAIL) - 1)]


def tail_shape(angles, sway=0.0, phase=0.0, lag=0.55, curl=0.0, wave=0.0):
    """The tail laid along world directions: angles (degrees) per bone from straight back,
    - down, + up; sway swings it side to side as a wave travelling to the tip; curl turns it
    progressively to the left along the ground. No bone ends below the ground."""
    q0, qh = ROT.get("root", Quaternion()), ROT.get("hips", Quaternion())
    root_head, hips_head = bones["root"].head_local, bones["hips"].head_local
    hips_at = root_head + q0 @ (hips_head - root_head) + LOC.get("root", Vector())
    pos = hips_at + (q0 @ qh) @ (bones["tail1"].head_local - hips_head)
    acc = q0 @ qh
    n = len(TAIL_BONES)
    for i, name in enumerate(TAIL_BONES):
        f = (i + 1) / n
        angle = math.radians(angles[i] + wave * f * math.sin(phase - i * lag + 1.2))
        d = Vector((0, math.cos(angle), math.sin(angle)))
        d = yaw_left(math.radians(sway) * f * math.sin(phase - i * lag) + math.radians(curl) * f) @ d
        length = bones[name].length
        if (pos + d * length).z < 0.018:
            dz = max(-1.0, min(1.0, (0.018 - pos.z) / length))
            flat = Vector((d.x, d.y, 0)).normalized() * math.sqrt(max(0.0, 1 - dz * dz))
            d = Vector((flat.x, flat.y, dz))
        rest = (bones[name].tail_local - bones[name].head_local).normalized()
        q = rest.rotation_difference(acc.inverted() @ d)
        set_rot(name, q)
        acc = acc @ q
        pos = pos + d * length


# ---- Clips -----------------------------------------------------------------------------------
HIP_H = 0.85 * 0.65


def design(speed, duty):
    fr = speed * speed / (9.81 * HIP_H)
    length = 2.3 * HIP_H * fr ** 0.3
    return length / speed, duty * length  # cycle seconds, stance sweep


WALK_T, WALK_S = design(0.95, 0.66)
TROT_T, TROT_S = design(2.0, 0.44)
GALLOP_T, GALLOP_S = design(5.5, 0.26)
SNEAK_T, SNEAK_S = design(0.45, 0.78)

BASE = dict(fore_offset=-0.025, hind_offset=0.0, fore_width=0.05, hind_width=0.055, fore_roll=26, hind_roll=30,
            heel_from=0.66, heel=34, liftoff_back=0.0, fore_lift=0.075, hind_lift=0.06, fore_flex=95, hind_flex=34)
GAITS = {
    "Walk": dict(BASE, duty=0.66, sweep=WALK_S, phases={"hind.L": 0.0, "fore.L": 0.24, "hind.R": 0.5, "fore.R": 0.74}),
    "Run": dict(BASE, duty=0.44, sweep=TROT_S, fore_lift=0.10, hind_lift=0.085, fore_flex=105, hind_flex=42, heel=38,
                phases={"hind.L": 0.0, "fore.R": 0.02, "hind.R": 0.5, "fore.L": 0.52}),
    "Gallop": dict(BASE, duty=0.26, sweep=GALLOP_S, fore_lift=0.13, hind_lift=0.11, fore_flex=115, hind_flex=50, heel=40,
                   fore_offset=0.0, hind_offset=0.02, fore_width=0.045, hind_width=0.05,
                   phases={"hind.L": 0.0, "hind.R": 0.1, "fore.R": 0.44, "fore.L": 0.56}),
    "Sneak": dict(BASE, duty=0.78, sweep=SNEAK_S, fore_lift=0.05, hind_lift=0.04, fore_flex=80, hind_flex=26, heel=20,
                  fore_offset=0.02, hind_offset=0.06, fore_width=0.06, hind_width=0.06,
                  phases={"hind.L": 0.0, "fore.L": 0.25, "hind.R": 0.5, "fore.R": 0.75}),
}


def legs_for(gait, t):
    return {leg: stride(leg, (t + gait["phases"][leg]) % 1.0, gait) for leg in LEG_KEYS}


def stance_weight(gait, t, leg):
    u = (t + gait["phases"][leg]) % 1.0
    return math.sin(math.pi * u / gait["duty"]) if u < gait["duty"] else 0.0


def scapulae(gait, t, legs, extra_pitch=0.0, rise=0.012):
    """The shoulder blade swings with its leg and rises over it while it bears weight."""
    for leg in ("fore.L", "fore.R"):
        s = leg[-1]
        ball_a = -legs[leg][1].y
        a_n = SHOULDER_A + gait["fore_offset"]
        swing = (ball_a - a_n) / max(gait["sweep"], 1e-3)
        # pitch_up turns this down-pointing bone's lower end (the shoulder joint) forward.
        set_rot(f"scapula.{s}", pitch_up(math.radians(20) * swing + math.radians(extra_pitch)))
        set_loc(f"scapula.{s}", Vector((0, 0, rise * stance_weight(gait, t, leg))))


def gait_pose(name):
    gait = GAITS[name]

    def frame(t):
        legs = legs_for(gait, t)
        two = 2 * math.pi * t
        if name == "Walk":
            set_loc("root", Vector((0, 0, -0.018 + 0.006 * math.cos(2 * two))))
            set_rot("hips", roll_right(math.radians(3) * math.sin(two)) @ yaw_left(math.radians(4) * math.sin(two - 0.6)))
            set_rot("spine1", yaw_left(math.radians(-1.5) * math.sin(two - 0.6)))
            set_rot("spine3", yaw_left(math.radians(1.5) * math.sin(two - 2.0)))
            set_rot("chest", roll_right(math.radians(-2.5) * math.sin(two - 1.6)))
            set_rot("neck1", pitch_up(math.radians(-8)))
            set_rot("head", pitch_up(math.radians(4) + math.radians(2) * math.cos(2 * two)))
            scapulae(gait, t, legs)
            tail_shape([-72, -74, -72, -66, -52, -32, -12, 12, 34], sway=7, phase=two - 0.8, wave=4)
        elif name == "Run":
            # Cats run low: the body sinks so the legs reach the stride's ends.
            set_loc("root", Vector((0, 0, -0.045 + 0.011 * math.cos(2 * two - 0.4))))
            set_rot("hips", roll_right(math.radians(2) * math.sin(two)) @ pitch_up(math.radians(1.5) * math.sin(2 * two)))
            set_rot("chest", pitch_up(math.radians(-1.5) * math.sin(2 * two)))
            set_rot("neck1", pitch_up(math.radians(-6)))
            set_rot("head", pitch_up(math.radians(3) - math.radians(2) * math.cos(2 * two - 0.4)))
            scapulae(gait, t, legs, rise=0.015)
            tail_shape([-52, -44, -34, -24, -14, -6, 4, 14, 24], sway=6, phase=two - 0.8, wave=6)
        elif name == "Gallop":
            # Rotary gallop: the back gathers (arched) as the hind paws swing through and land,
            # and stretches as they drive and the fore paws reach.
            flex = math.cos(2 * math.pi * (t - 0.02))  # +1 gathered, -1 stretched
            for bone, share in (("spine1", 0.35), ("spine2", 0.35), ("spine3", 0.3)):
                set_rot(bone, pitch_up(math.radians(-16) * share * flex))
            set_rot("hips", pitch_up(math.radians(18) * flex))
            set_rot("chest", pitch_up(math.radians(8) * flex))
            set_loc("root", Vector((0, 0.02 * flex, -0.055 + 0.03 * math.cos(2 * two - 2 * math.pi * 0.36))))
            set_rot("root", pitch_up(math.radians(-5) * math.sin(two - 0.9)))
            set_rot("neck1", pitch_up(math.radians(-4) + math.radians(5) * flex))
            set_rot("head", pitch_up(math.radians(2) - math.radians(5) * flex))
            scapulae(gait, t, legs, rise=0.012)
            tail_shape([-14, -8, -3, 0, 1, 3, 6, 10, 14], sway=4, phase=two, lag=0.45, wave=14)
        else:  # Sneak: low, slow, shoulder blades high, head level with the back
            set_loc("root", Vector((0, 0, -0.105 + 0.004 * math.cos(2 * two))))
            set_rot("hips", pitch_up(math.radians(-4)) @ roll_right(math.radians(2) * math.sin(two)))
            set_rot("spine1", pitch_up(math.radians(3)))
            set_rot("chest", pitch_up(math.radians(-6)))
            set_rot("neck1", pitch_up(math.radians(-14)))
            set_rot("neck2", pitch_up(math.radians(4)))
            set_rot("head", pitch_up(math.radians(10)))
            scapulae(gait, t, legs, extra_pitch=-6, rise=0.03)
            tail_shape([-62, -52, -36, -18, -8, -4, -2, 10, 24], sway=4, phase=two, wave=3)
        return legs
    return frame


def stand_legs(width_f=0.058, width_h=0.06, fore_a=None, hind_a=None):
    fa = SHOULDER_A - 0.02 if fore_a is None else fore_a
    ha = HIP_A + 0.03 if hind_a is None else hind_a
    return {leg: paw(leg, GEOM[leg]["side"] * (width_f if leg.startswith("fore") else width_h),
                     fa if leg.startswith("fore") else ha) for leg in LEG_KEYS}


def idle(t):
    two = 2 * math.pi * t
    breath = math.sin(2 * two)
    set_loc("root", Vector((0, 0, 0.002 * breath)))
    set_rot("chest", pitch_up(math.radians(0.8) * breath))
    set_rot("neck1", pitch_up(math.radians(-5)))
    look = math.sin(two) * smooth(min(1, 3 * abs(math.sin(two))))
    set_rot("neck2", yaw_left(math.radians(12) * look))
    set_rot("head", pitch_up(math.radians(3)) @ yaw_left(math.radians(10) * look))
    tail_shape([-76, -78, -76, -70, -56, -36, -14, 14, 38], sway=8 * math.sin(two), phase=3 * two, lag=0.45, wave=3)
    return stand_legs()


def crouch_legs(fore_forward=0.06, hind_forward=0.10, hock_back=0.13, fore_theta=None):
    out = {}
    for leg in LEG_KEYS:
        g = GEOM[leg]
        x = g["side"] * (0.07 if leg.startswith("fore") else 0.075)
        if leg.startswith("fore"):
            out[leg] = paw(leg, x, SHOULDER_A + fore_forward, theta=fore_theta)
        else:
            # Folded: the foot lies nearly flat, hock close to the ground behind the paw.
            theta = -math.atan2(hock_back, 0.035)
            out[leg] = paw(leg, x, HIP_A + hind_forward, theta=theta)
    return out


def eating(t):
    two = 2 * math.pi * t
    tug = max(0.0, math.sin(two)) ** 2
    set_loc("root", Vector((0, 0.02, -0.17)))
    set_rot("hips", pitch_up(math.radians(-6)))
    set_rot("spine3", pitch_up(math.radians(-6)))
    set_rot("chest", pitch_up(math.radians(-6)))
    set_rot("neck1", pitch_up(math.radians(-26) + math.radians(10) * tug) @ yaw_left(math.radians(6) * math.sin(two * 2)))
    set_rot("neck2", pitch_up(math.radians(2)))
    set_rot("head", pitch_up(math.radians(14) + math.radians(8) * tug) @ yaw_left(math.radians(-10) * tug))
    for s in "LR":
        set_loc(f"scapula.{s}", Vector((0, 0, 0.03)))
    tail_shape([-70, -55, -28, -8, -4, -2, 0, 4, 12], sway=4, phase=two, curl=20, wave=2)
    return crouch_legs(fore_forward=0.10)


def drinking(t):
    lap = math.sin(2 * math.pi * 4 * t)
    set_loc("root", Vector((0, 0.015, -0.15)))
    set_rot("hips", pitch_up(math.radians(-8)))
    set_rot("chest", pitch_up(math.radians(-8)))
    set_rot("neck1", pitch_up(math.radians(-28)))
    set_rot("neck2", pitch_up(math.radians(2)))
    set_rot("head", pitch_up(math.radians(16) + math.radians(4) * lap))
    for s in "LR":
        set_loc(f"scapula.{s}", Vector((0, 0, 0.04)))
    tail_shape([-70, -55, -28, -8, -4, -2, 0, 4, 12], sway=3, phase=2 * math.pi * t, curl=-25)
    return crouch_legs(fore_forward=0.03, hind_forward=0.09)


def resting(t):
    breath = math.sin(2 * math.pi * 2 * t)
    set_loc("root", Vector((0, 0.02, -0.235 + 0.003 * breath)))
    set_rot("chest", pitch_up(math.radians(1.0) * breath))
    set_rot("neck1", pitch_up(math.radians(4)))
    set_rot("head", pitch_up(math.radians(-6)) @ yaw_left(math.radians(5) * math.sin(2 * math.pi * t)))
    for s in "LR":
        set_loc(f"scapula.{s}", Vector((0, 0, 0.02)))
    tail_shape([-60, -30, -8, -4, -2, 0, 0, 0, 4], sway=3, phase=2 * math.pi * t, curl=150, wave=2)
    out = {}
    for leg in LEG_KEYS:
        g = GEOM[leg]
        if leg.startswith("fore"):
            # Sphinx: forearms flat on the ground, paws ahead.
            x = g["side"] * 0.06
            out[leg] = paw(leg, x, SHOULDER_A + 0.17, theta=math.radians(-80), gamma=0.0)
        else:
            # Folded beside the body: foot flat, paw forward under the thigh.
            x = g["side"] * 0.12
            out[leg] = paw(leg, x, HIP_A + 0.16, theta=math.radians(-82), gamma=0.0)
    return out


def pounce(t):
    # 0–0.3 gather, 0.3–0.5 spring, 0.5–0.78 flight, 0.78–1 land.
    gather = smooth(t / 0.3) * (1 - smooth((t - 0.3) / 0.15))
    spring = smooth((t - 0.3) / 0.2) * (1 - smooth((t - 0.78) / 0.22))
    land = smooth((t - 0.78) / 0.22)
    set_loc("root", Vector((0, 0.05 * spring, -0.11 * gather + 0.16 * spring - 0.05 * land)))
    set_rot("root", pitch_up(math.radians(16) * spring * (1 - smooth((t - 0.55) / 0.25)) - math.radians(8) * land))
    set_rot("hips", pitch_up(math.radians(-8) * gather))
    for bone in ("spine1", "spine2", "spine3"):
        set_rot(bone, pitch_up(math.radians(3) * gather - math.radians(4) * spring))
    set_rot("neck1", pitch_up(math.radians(-12) * gather + math.radians(6) * spring))
    set_rot("head", pitch_up(math.radians(10) * gather - math.radians(10) * land))
    tail_shape([-62 + 50 * spring, -50 + 44 * spring, -30 + 30 * spring, -10 + 12 * spring, -2 + 6 * spring, 0, 4, 10, 18],
               sway=6 * gather, phase=2 * math.pi * 3 * t, wave=4)
    legs = {}
    for leg in LEG_KEYS:
        g, fore = GEOM[leg], leg.startswith("fore")
        x = g["side"] * (0.06 if fore else 0.065)
        if fore:
            a = SHOULDER_A - 0.02 + 0.30 * spring + 0.06 * land
            lift = 0.20 * spring * (1 - land)
            theta = g["theta0"] + math.radians(60) * spring * (1 - land)
            legs[leg] = paw(leg, x, a, lift=lift, theta=theta)
        else:
            a = HIP_A + 0.03 + 0.06 * gather - 0.30 * spring + 0.2 * land
            lift = 0.14 * spring * (1 - land)
            theta = g["theta0"] - math.radians(30) * gather + math.radians(55) * spring * (1 - land)
            legs[leg] = paw(leg, x, a, lift=lift, theta=theta)
    return legs


def bite(t):
    shake = math.sin(2 * math.pi * 3 * t)
    set_loc("root", Vector((0, 0.03, -0.06)))
    set_rot("hips", pitch_up(math.radians(-3)))
    set_rot("chest", pitch_up(math.radians(-8)))
    set_rot("neck1", pitch_up(math.radians(-18)) @ yaw_left(math.radians(5) * shake))
    set_rot("neck2", pitch_up(math.radians(2)))
    set_rot("head", pitch_up(math.radians(8)) @ yaw_left(math.radians(7) * shake))
    for s in "LR":
        set_loc(f"scapula.{s}", Vector((0, 0, 0.02)))
    tail_shape([-66, -62, -52, -38, -22, -6, 10, 24, 34], sway=8, phase=2 * math.pi * 3 * t, wave=5)
    return stand_legs(width_f=0.075, width_h=0.07, fore_a=SHOULDER_A + 0.05, hind_a=HIP_A + 0.0)


DEATH_LIMP = {"upperarm": -25, "forearm": 30, "hand": -20, "thigh": 25, "shin": -35, "foot": 25}


def death(t):
    # The legs buckle (paws still planted), the body rolls onto its right side, and it sinks
    # only as fast as the roll lets the legs clear the ground.
    buckle = smooth(t / 0.3)
    fall = smooth((t - 0.28) / 0.37)
    sink = smooth((t - 0.45) / 0.35)
    drop = bones["root"].head_local.z - 0.9 * TORSO_HALF
    set_loc("root", Vector((-0.07 * fall, 0, -min(0.12, 0.45 * drop) * buckle - (drop - min(0.12, 0.45 * drop)) * sink)))
    set_rot("root", roll_right(math.radians(8) * buckle + math.radians(78) * fall))
    set_rot("neck1", pitch_up(math.radians(-14) * fall) @ yaw_left(math.radians(-10) * fall))
    set_rot("head", pitch_up(math.radians(-10) * fall) @ roll_right(math.radians(-20) * fall))
    tail_shape([-72 + 30 * fall, -70 + 60 * fall, -66 + 64 * fall, -60 + 60 * fall, -48 + 48 * fall, -30 + 30 * fall, -12 + 12 * fall, 10 - 10 * fall, 30 - 30 * fall])
    limp = smooth((t - 0.28) / 0.14)
    for leg in LEG_KEYS:
        for i, bone in enumerate(chain(leg)[:3]):
            base = bone.split(".")[0]
            if base in DEATH_LIMP:
                q = pitch_up(math.radians(DEATH_LIMP[base]) * limp)
                if i == 0:
                    # Lying on its right side: the lower legs swing up off the ground, the upper
                    # ones droop toward it (a splayed stance would otherwise reach into the ground).
                    q = roll_right(math.radians(20 if leg.endswith(".R") else -10) * limp) @ q
                set_rot(bone, q)
    legs = stand_legs()
    return legs, {leg: 1 - limp for leg in LEG_KEYS}


CLIPS = [
    ("Idle", idle, 4.0, True),
    ("Walk", gait_pose("Walk"), WALK_T, True),
    ("Run", gait_pose("Run"), TROT_T, True),
    ("Gallop", gait_pose("Gallop"), GALLOP_T, True),
    ("Sneak", gait_pose("Sneak"), SNEAK_T, True),
    ("Eating", eating, 2.0, True),
    ("Drinking", drinking, 1.0, True),
    ("Resting", resting, 4.0, True),
    ("Pounce", pounce, 1.0, False),
    ("Bite", bite, 1.0, True),
    ("Death", death, 1.4, False),
]
if args.clips:
    CLIPS = [c for c in CLIPS if c[0] in args.clips.split(",")]

# ---- Key, solve and bake each clip ----------------------------------------------------------
DEFORM = [b.name for b in bones]
EMPTIES = [o for leg in LEG_KEYS for k, o in controls[leg].items() if k != "pole"]


def reset_pose():
    ROT.clear()
    LOC.clear()
    for pb in pose:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()


baked = {}
bpy.context.view_layer.objects.active = arm
for name, fn, seconds, cyclic in CLIPS:
    frames = max(8, round(seconds * CAT["time"] * FPS))
    for o in [arm] + EMPTIES:
        if o.animation_data:
            o.animation_data.action = None
    slip = {}
    for f in range(frames + 1):
        t = f / frames
        reset_pose()
        result = fn(t if cyclic else t)
        legs, influence = result if isinstance(result, tuple) else (result, None)
        for leg in LEG_KEYS:
            wrist, ball, tip = legs[leg]
            # Keep a target the leg can reach: a stretched leg slides rather than snapping.
            root = GEOM[leg]["root"]
            controls[leg]["ik"].location = wrist
            controls[leg]["ball"].location = ball
            controls[leg]["tip"].location = tip
            for k in ("ik", "ball", "tip"):
                controls[leg][k].keyframe_insert("location", frame=f)
            c = pose[chain(leg)[1]].constraints["IK"]
            c.influence = 1.0 if influence is None else influence[leg]
            c.keyframe_insert("influence", frame=f)
            for con in (pose[chain(leg)[2]].constraints[0], pose[chain(leg)[3]].constraints[0]):
                con.influence = c.influence
                con.keyframe_insert("influence", frame=f)
        for pb in pose:
            pb.keyframe_insert("rotation_quaternion", frame=f)
            pb.keyframe_insert("location", frame=f)
    # Measure how far each planted paw ends from its target (reach) before baking.
    for f in range(frames + 1):
        scene.frame_set(f)
        if args.debug and name == args.debug:
            h, fg = pose["hand.L"], pose["fingers.L"]
            print(f"DBG {f:2d} wrist {(h.head - controls['fore.L']['ik'].location).length*1000:5.1f} "
                  f"ball {(h.tail - controls['fore.L']['ball'].location).length*1000:5.1f} "
                  f"tip {(fg.tail - controls['fore.L']['tip'].location).length*1000:5.1f} tipz {fg.tail.z*100:5.2f} target {controls['fore.L']['tip'].location.z*100:5.2f}")
        for leg in LEG_KEYS:
            if pose[chain(leg)[1]].constraints["IK"].influence < 0.99:
                continue
            hand = pose[chain(leg)[2]]
            target = controls[leg]["ik"].matrix_world.translation
            miss = ((arm.matrix_world @ hand.head) - target).length
            if miss > slip.get(leg, (0, 0))[0]:
                slip[leg] = (miss, f)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in pose:
        pb.select = True
    bpy.ops.nla.bake(frame_start=0, frame_end=frames, only_selected=True, visual_keying=True,
                     clear_constraints=False, use_current_action=False, bake_types={"POSE"})
    bpy.ops.object.mode_set(mode="OBJECT")
    action = arm.animation_data.action
    action.name = name
    action.use_fake_user = True
    baked[name] = (action, frames)
    misses = ", ".join(f"{leg} {m * 1000:.0f} mm @{f}" for leg, (m, f) in sorted(slip.items()))
    print(f"CLIP {name}: {frames} frames ({frames / FPS:.2f} s); worst wrist/hock miss: {misses}")

# ---- Ship plain keys: no constraints, no controls ------------------------------------------
for leg in LEG_KEYS:
    for pb_name in chain(leg):
        for con in list(pose[pb_name].constraints):
            pose[pb_name].constraints.remove(con)
for o in [o for leg in LEG_KEYS for o in controls[leg].values()]:
    bpy.data.objects.remove(o, do_unlink=True)
for action in list(bpy.data.actions):
    if action.name not in baked:
        bpy.data.actions.remove(action)
reset_pose()
arm.animation_data.action = None
for track in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(track)
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

# ---- Review: a side filmstrip of every clip -------------------------------------------------
if args.review:
    review = Path(args.review)
    review.mkdir(parents=True, exist_ok=True)
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 520, 400
    world = bpy.data.worlds.new("review"); scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.84, 0.82, 1)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3; sun.rotation_euler = (0.8, 0.2, 0.6); scene.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    camera = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"; camera.data.ortho_scale = 1.55
    scene.camera = camera
    views = {"side": Vector((3, 0, 0.35)), "three": Vector((2.1, -2.1, 0.9))}
    for name, (action, frames) in baked.items():
        for track in arm.animation_data.nla_tracks:
            track.mute = track.name != name
        for view, at in views.items():
            if view == "three" and name not in ("Walk", "Run", "Gallop", "Resting"):
                continue
            camera.location = at
            camera.rotation_euler = (Vector((0, 0, 0.32)) - at).to_track_quat("-Z", "Y").to_euler()
            for i in range(8):
                scene.frame_set(round(frames * i / 8))
                scene.render.filepath = str(review / f"{name}-{view}-{i}.png")
                bpy.ops.render.render(write_still=True)
    print("RENDERED")
