"""Bind a generated static animal mesh to an existing rig and keep every clip.

    Blender -b --python tools/art/bind_to_rig.py -- \
        --mesh new.glb --rig packages/client/public/assets/animals/Bull.glb \
        --out Boar.glb [--mesh-forward -X] [--keep-mesh-of-rig] [--decimate 0.5] [--texture 1024]

The rig's rest pose is rescaled per axis to the new mesh's bounding box (length, width,
height), so joints land inside the new body; location keys are rescaled to match, rotation
keys are kept as authored. The mesh is skinned with Blender's automatic (bone heat) weights,
falling back to envelope weights where heat fails. Textures are downsized to --texture px.
Review renders (front/side, Idle and Walk) are written next to --out as PNGs.
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--mesh", required=True)
parser.add_argument("--rig", required=True)
parser.add_argument("--out", required=True)
# The direction the new mesh's head points in its own file; the rig's head points to -Y.
parser.add_argument("--mesh-forward", default="auto", choices=["auto", "X", "-X", "Y", "-Y", "Z", "-Z"])
parser.add_argument("--decimate", type=float, default=1.0)
parser.add_argument("--texture", type=int, default=1024)
parser.add_argument("--renders", type=int, default=1)
parser.add_argument("--review-clips", default="Idle,Walk")
# Bones of the old body that lie outside the new one (a cow's long tail on a boar) must not
# pull skin, or the surface stretches toward them when they swing.
parser.add_argument("--no-deform", default="")
# Re-lay the rig's tail chain along the new body's own tail (a hanging tail on a rig whose tail
# sticks out), so tail swings move the tail rather than dragging the thighs.
parser.add_argument("--fit-tail", action="store_true")
# feet: align front and hind feet with the rig's (right when tails differ, e.g. canids).
# bbox: match nose-to-tail length (right when the rig's legs are much longer, e.g. boar on bull).
parser.add_argument("--fit", choices=["feet", "bbox"], default="feet")
# A skull bearing horns (a buffalo's) moves as one with this bone: bone heat would let the horn
# tips follow the neck too, and they stretch when the head goes down.
parser.add_argument("--rigid-head", default="")
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)


def imported(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def action_fcurves(action):
    """F-curves of an action in both the legacy and the layered (Blender 4.4+) action APIs."""
    if hasattr(action, "fcurves"):
        yield from action.fcurves
        return
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def world_bbox(objects):
    bpy.context.view_layer.update()  # bound_box is stale until the depsgraph re-evaluates
    points = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def apply_transforms(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


# ---- The rig, its clips, and the body it currently skins ---------------------------------
rig_objects = imported(args.rig)
armature = next(o for o in rig_objects if o.type == "ARMATURE")
old_meshes = [o for o in rig_objects if o.type == "MESH"]
# The skinned body, not a stray helper mesh (several packs ship an unskinned icosphere).
skinned = [o for o in old_meshes if o.parent == armature or any(m.type == "ARMATURE" for m in o.modifiers)]
old_body = max(skinned or old_meshes, key=lambda o: len(o.data.vertices))
rig_lo, rig_hi = world_bbox([old_body])
for mesh in old_meshes:
    bpy.data.objects.remove(mesh, do_unlink=True)

# ---- The new mesh: one object, head toward -Y, feet on z = 0 ------------------------------
rig_actions = set(bpy.data.actions)
mesh_import = imported(args.mesh)
# A source that brings its own skeleton or clips contributes only its surface.
for action in [a for a in bpy.data.actions if a not in rig_actions]:
    bpy.data.actions.remove(action)
new_objects = [o for o in mesh_import if o.type == "MESH"]
for o in new_objects:
    matrix = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = matrix
    o.modifiers.clear()
    o.vertex_groups.clear()
    o.shape_key_clear()
for o in mesh_import:
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for o in new_objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = new_objects[0]
if len(new_objects) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "Body"
apply_transforms(body)

lo, hi = world_bbox([body])
size = hi - lo
forward = args.mesh_forward
if forward == "auto":
    # Quadrupeds are longest nose to tail; the head end is the taller one.
    axis = "X" if size.x >= size.y else "Y"
    index = 0 if axis == "X" else 1
    mid = (lo[index] + hi[index]) / 2
    verts = [body.matrix_world @ v.co for v in body.data.vertices]
    top_low = max((v.z for v in verts if v[index] < mid), default=0)
    top_high = max((v.z for v in verts if v[index] >= mid), default=0)
    forward = ("-" if top_low > top_high else "") + axis
turn = {"-Y": 0, "Y": math.pi, "X": -math.pi / 2, "-X": math.pi / 2}.get(forward)
if turn is None:
    raise SystemExit(f"unsupported --mesh-forward {forward}")
body.rotation_mode = "XYZ"  # glTF import leaves QUATERNION, which ignores rotation_euler
body.rotation_euler = (0, 0, turn)
apply_transforms(body)
lo, hi = world_bbox([body])
body.location = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
apply_transforms(body)

# Align by anatomy, not by bounding box: tails differ (a fox's sticks out, a dhole's hangs), so
# nose-to-tail length would misplace the hips. Scale and slide the new body so its front and
# hind feet stand where the rig's front and hind feet are.
def mesh_feet_y(obj):
    verts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    floor, top = min(v.z for v in verts), max(v.z for v in verts)
    low = [v for v in verts if v.z < floor + (top - floor) * 0.12]
    mid = (min(v.y for v in low) + max(v.y for v in low)) / 2
    front = sorted(v.y for v in low if v.y < mid) or [mid]
    back = sorted(v.y for v in low if v.y >= mid) or [mid]
    return front[len(front) // 2], back[len(back) // 2]


def rig_feet_y(arm):
    bones = list(arm.data.bones)
    deform = [b for b in bones if b.use_deform and not b.name.startswith(("IK", "Pole"))]
    leaves = [b for b in deform if not any(c.use_deform for c in b.children)]
    floor = min(b.tail_local.z for b in leaves)
    top = max(max(b.head_local.z, b.tail_local.z) for b in deform)
    feet = [b for b in leaves if b.tail_local.z < floor + (top - floor) * 0.2]
    ys = sorted(b.tail_local.y for b in feet)
    mid = (ys[0] + ys[-1]) / 2
    front = [y for y in ys if y < mid] or ys
    back = [y for y in ys if y >= mid] or ys
    return sum(front) / len(front), sum(back) / len(back)


rig_front, rig_back = rig_feet_y(armature)
mesh_front, mesh_back = mesh_feet_y(body)
if args.fit == "bbox" or abs(rig_back - rig_front) < (rig_hi.y - rig_lo.y) * 0.2 or abs(mesh_back - mesh_front) < (hi.y - lo.y) * 0.2:
    # A biped (a bird on two close feet) has no front and hind pair: match body length instead.
    uniform = (rig_hi.y - rig_lo.y) / (hi.y - lo.y)
    body.scale = (uniform, uniform, uniform)
    apply_transforms(body)
    lo, hi = world_bbox([body])
    body.location = Vector((0, (rig_lo.y + rig_hi.y) / 2 - (lo.y + hi.y) / 2, rig_lo.z - lo.z))
    print(f"FIT body length (bbox), scaled x{uniform:.4f}")
else:
    uniform = (rig_back - rig_front) / (mesh_back - mesh_front)
    body.scale = (uniform, uniform, uniform)
    apply_transforms(body)
    mesh_front, mesh_back = mesh_feet_y(body)
    lo, hi = world_bbox([body])
    body.location = Vector((0, rig_front - mesh_front, rig_lo.z - lo.z))
    print(f"FEET rig {rig_front:.3f}..{rig_back:.3f} mesh scaled x{uniform:.4f}")
apply_transforms(body)
lo, hi = world_bbox([body])

# ---- Fit the skeleton's rest pose to the new body ----------------------------------------
fit = Vector(((hi.x - lo.x) / (rig_hi.x - rig_lo.x), 1.0, (hi.z - lo.z) / (rig_hi.z - rig_lo.z)))
print(f"FIT width x{fit.x:.3f} height x{fit.z:.3f} (forward {forward}, uniform {uniform:.4f})")
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="EDIT")
ground = rig_lo.z
for bone in armature.data.edit_bones:
    for attr in ("head", "tail"):
        p = getattr(bone, attr)
        setattr(bone, attr, Vector((p.x * fit.x, p.y, ground + (p.z - ground) * fit.z)))
if args.fit_tail:
    chain = []
    bone = next((b for b in armature.data.edit_bones if b.name.lower().startswith("tail")
                 and not (b.parent and b.parent.name.lower().startswith("tail"))), None)
    while bone:
        chain.append(bone)
        bone = next((c for c in bone.children if c.name.lower().startswith("tail")), None)
    if chain:
        verts = [body.matrix_world @ v.co for v in body.data.vertices]
        width = hi.x - lo.x
        _, hind = mesh_feet_y(body)
        base = chain[0].head.copy()
        behind = [v for v in verts if v.y > hind + (hi.y - lo.y) * 0.08 and abs(v.x) < width * 0.2]
        behind.sort(key=lambda v: (v - base).length)
        if len(behind) >= len(chain) * 4:
            per = len(behind) // len(chain)
            joints = []
            for i in range(len(chain)):
                group = behind[i * per:(i + 1) * per] if i < len(chain) - 1 else behind[i * per:]
                joints.append(sum(group, Vector()) / len(group))
            start = base
            for bone, end in zip(chain, joints):
                bone.use_connect = False
                bone.head, bone.tail = start, end
                start = end
            print(f"TAIL refitted {len(chain)} bones along {len(behind)} tail vertices")
bpy.ops.object.mode_set(mode="OBJECT")
mean = (fit.x + fit.z) / 2
for action in bpy.data.actions:
    for curve in action_fcurves(action):
        if curve.data_path.endswith(".location"):
            for key in curve.keyframe_points:
                key.co.y *= mean
                key.handle_left.y *= mean
                key.handle_right.y *= mean

# ---- Lighter mesh and textures -------------------------------------------------------------
if args.decimate < 1.0:
    modifier = body.modifiers.new("decimate", "DECIMATE")
    modifier.ratio = args.decimate
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=modifier.name)
for image in bpy.data.images:
    if image.size[0] > args.texture:
        image.scale(args.texture, int(image.size[1] * args.texture / image.size[0]))

# ---- Skin ----------------------------------------------------------------------------------
for name in [n for n in args.no_deform.split(",") if n] + [b.name for b in armature.data.bones if b.name.startswith(("IK", "Pole"))]:
    bone = armature.data.bones.get(name)
    if bone:
        bone.use_deform = False

# Generated meshes are rarely watertight, and bone heat fails on them. Weight a clean voxel
# remesh of the same body instead, then copy those weights onto the real surface.
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
bpy.context.collection.objects.link(proxy)
remesh = proxy.modifiers.new("remesh", "REMESH")
remesh.mode = "VOXEL"
remesh.voxel_size = (hi.y - lo.y) / 140
bpy.context.view_layer.objects.active = proxy
bpy.ops.object.modifier_apply(modifier=remesh.name)
bpy.ops.object.select_all(action="DESELECT")
proxy.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
proxy_unweighted = sum(1 for v in proxy.data.vertices if not v.groups)
print(f"SKIN proxy vertices {len(proxy.data.vertices)} unweighted {proxy_unweighted}")
if proxy_unweighted > len(proxy.data.vertices) * 0.02:
    print("SKIN bone heat failed on the proxy too; using envelope weights")
    for group in list(proxy.vertex_groups):
        proxy.vertex_groups.remove(group)
    bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
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
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type="ARMATURE_NAME")
unweighted = sum(1 for v in body.data.vertices if not v.groups)
print(f"SKIN vertices {len(body.data.vertices)} unweighted {unweighted}")
# An unweighted vertex stays at its rest position while the body moves and shows as a sliver.
# Give each the weights of its nearest weighted neighbour.
if unweighted:
    from mathutils.kdtree import KDTree
    weighted = [v for v in body.data.vertices if v.groups]
    tree = KDTree(len(weighted))
    for i, v in enumerate(weighted):
        tree.insert(v.co, i)
    tree.balance()
    for v in [v for v in body.data.vertices if not v.groups]:
        _, nearest, _ = tree.find(v.co)
        for g in weighted[nearest].groups:
            body.vertex_groups[g.group].add([v.index], g.weight, "REPLACE")
    unweighted = sum(1 for v in body.data.vertices if not v.groups)
    print(f"SKIN after nearest-neighbour fill: unweighted {unweighted}")

# Small detached pieces of the surface (a hoof, a horn tip) are separate islands of the mesh; the
# proxy's weights can pin one to the wrong limb, and it floats away when that limb moves. Each
# small island follows, rigidly, the body point closest to any part of it (a hoof meets the foot of
# its own leg); a crumb under 1% of the surface (a dewclaw, ~50 vertices) is dropped rather than left floating.
import bmesh
from mathutils.kdtree import KDTree as _KDTree
bm = bmesh.new()
bm.from_mesh(body.data)
bm.verts.ensure_lookup_table()
island_of = [-1] * len(bm.verts)
islands = []
for start in bm.verts:
    if island_of[start.index] != -1:
        continue
    stack, members = [start], []
    island_of[start.index] = len(islands)
    while stack:
        v = stack.pop()
        members.append(v.index)
        for e in v.link_edges:
            w = e.other_vert(v)
            if island_of[w.index] == -1:
                island_of[w.index] = len(islands)
                stack.append(w)
    islands.append(members)
bm.free()
main = max(range(len(islands)), key=lambda i: len(islands[i]))
small = [i for i, members in enumerate(islands) if i != main and len(members) < len(body.data.vertices) * 0.02]
if small:
    tree = _KDTree(len(islands[main]))
    for k, vi in enumerate(islands[main]):
        tree.insert(body.data.vertices[vi].co, k)
    tree.balance()
    crumbs = []
    for i in small:
        if len(islands[i]) < len(body.data.vertices) * 0.01:
            crumbs += islands[i]
            continue
        best = min((tree.find(body.data.vertices[vi].co) for vi in islands[i]), key=lambda hit: hit[2])
        anchor = body.data.vertices[islands[main][best[1]]]
        for vi in islands[i]:
            for g in list(body.data.vertices[vi].groups):
                body.vertex_groups[g.group].remove([vi])
            for g in anchor.groups:
                body.vertex_groups[g.group].add([vi], g.weight, "REPLACE")
    if crumbs:
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.verts[vi] for vi in crumbs], context="VERTS")
        bm.to_mesh(body.data)
        bm.free()
print(f"SKIN islands {len(islands)} (small: {[len(islands[i]) for i in small]} of {len(body.data.vertices)}); {len(small)} small ones follow the body point nearest them or, as crumbs, are dropped")

if args.rigid_head:
    def segment_distance(p, a, b):
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
        return (p - (a + ab * t)).length
    deform = [b for b in armature.data.bones if b.use_deform]
    ends = {b.name: (armature.matrix_world @ b.head_local, armature.matrix_world @ b.tail_local) for b in deform}
    head = body.vertex_groups.get(args.rigid_head) or body.vertex_groups.new(name=args.rigid_head)
    head_bone = armature.data.bones[args.rigid_head]
    neck = head_bone.parent.name if head_bone.parent else None
    base_z = ends[args.rigid_head][0].z
    rigid = 0
    for v in body.data.vertices:
        p = body.matrix_world @ v.co
        nearest = min(ends, key=lambda n: segment_distance(p, *ends[n]))
        # The skull, and what rises above the head's base from it (horns) though nearer the neck.
        if nearest != args.rigid_head and not (nearest == neck and p.z > base_z):
            continue
        for g in list(v.groups):
            body.vertex_groups[g.group].remove([v.index])
        head.add([v.index], 1.0, "REPLACE")
        rigid += 1
    print(f"SKIN {rigid} vertices nearest the {args.rigid_head} move rigidly with it")

# ---- Every clip as its own NLA track, so the exporter writes them all ----------------------
armature.animation_data_create()
for track in list(armature.animation_data.nla_tracks):
    armature.animation_data.nla_tracks.remove(track)
for action in bpy.data.actions:
    track = armature.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, int(action.frame_range[0]), action)
armature.animation_data.action = None

out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="WEBP",
                          export_draco_mesh_compression_enable=False, export_apply=False)
print(f"WROTE {out} {out.stat().st_size} bytes")

# ---- Review renders: front and side, rest and mid-walk -------------------------------------
if args.renders:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 900, 600
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("review"); scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.84, 0.82, 1)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3; sun.rotation_euler = (0.8, 0.2, 0.6); scene.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, rig_lo.z))
    camera = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(camera)
    scene.camera = camera
    length = max(hi.y - lo.y, hi.z - lo.z)
    centre = Vector((0, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2))
    views = {"side": Vector((length * 2.2, 0, 0)), "front": Vector((0, -length * 2.2, 0)), "three-quarter": Vector((length * 1.6, -length * 1.6, length * 0.5))}
    for clip in args.review_clips.split(","):
        action = bpy.data.actions.get(clip)
        if not action:
            continue
        for track in armature.animation_data.nla_tracks:
            track.mute = track.name != clip
        scene.frame_set(int(action.frame_range[0] + (action.frame_range[1] - action.frame_range[0]) * 0.3))
        for name, offset in views.items():
            camera.location = centre + offset
            direction = centre - camera.location
            camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(out.with_name(f"{out.stem}-{clip.lower()}-{name}.png"))
            bpy.ops.render.render(write_still=True)
    print("RENDERED")
