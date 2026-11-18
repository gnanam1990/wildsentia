"""Builds the forest elephant's Walk, Drinking and Death clips on its rig.

    Blender -b --python tools/art/forest_elephant_clips.py -- --in ForestElephant.glb --out ForestElephant.glb

The generic elephant rig (OpenGameArt, CC0) walks with its legs barely lifting, has no drinking
clip (its Eating raises the trunk into the branches) and no death. Keyframed here, not motion
capture, from the rig's rest pose, which stands square:
- Walk (2 s): a lateral-sequence walk (left hind, left fore, right hind, right fore a quarter
  cycle apart) on straight, columnar legs. A planted leg turns as one about its shoulder or hip,
  23 degrees either side of upright, its pad rolling heel to toe. In the air a foreleg bends
  forward at the elbow and folds back hard at the wrist, the sole showing behind, and a hind leg
  bends back at the knee and lifts its foot low. The body bobs twice a cycle and rolls toward the
  side that bears it; the head nods, the trunk swings and the ears move once a cycle (a second
  beat in the clip would read as two strides to the game's gait clock, gait.ts strideCycles).
- Drinking (4 s): the head dips, the trunk reaches down to the water, holds, curls up to the
  mouth and returns.
- Death (2 s): the knees give, then the elephant rolls onto its side, legs relaxing; the root is
  lowered each frame so the body stays on the ground.
Other clips (Idle, Eating, Sitting, GettingUp, Angry) are kept as they are.
"""
import argparse
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--in", dest="src", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.src)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
arm.animation_data_create()
for track in arm.animation_data.nla_tracks:
    track.mute = True

# The animal's axes are taken from the world, whatever turn the armature carries: up is world +Z,
# forward runs from the root to the head bone, and the side axis is their cross product, toward the
# animal's right. A positive turn about it swings a hanging leg forward and tips the head up. All
# three are in armature space, where the bones live.
TO_ARMATURE = arm.matrix_world.to_3x3().normalized().inverted()
ARMATURE_SCALE = arm.matrix_world.to_scale().z
UP = (TO_ARMATURE @ Vector((0, 0, 1))).normalized()
_ahead = arm.matrix_world @ arm.data.bones["Bone.003"].head_local - arm.matrix_world @ arm.data.bones["Bone"].head_local
_ahead.z = 0
FORWARD = (TO_ARMATURE @ _ahead.normalized()).normalized()
SIDE = FORWARD.cross(UP).normalized()
MESH = next(o for o in bpy.data.objects if o.type == "MESH")
print("AXES up", tuple(round(c, 2) for c in UP), "forward", tuple(round(c, 2) for c in FORWARD), "side", tuple(round(c, 2) for c in SIDE))
LEGS = {  # leg: (upper, lower, foot, phase offset as a fraction of the cycle)
    "hind_left": ("UpperLegBack.L", "LowerLegBack.L", "FootBack.L", 0.0),
    "fore_left": ("UpperLegFront.L", "LowerLegFront.L", "FootFront.L", 0.25),
    "hind_right": ("UpperLegBack.L.001", "LowerLegBack.L.001", "FootBack.L.001", 0.5),
    "fore_right": ("UpperLegFront.L.001", "LowerLegFront.L.001", "FootFront.L.001", 0.75),
}
STANCE = 0.65  # share of the cycle a foot is on the ground (elephants walk at a duty factor of 0.6-0.7)
# Each leg turns 26 degrees either side of upright about its shoulder or hip, its pad turning back
# a quarter of that at the ankle. The game plays the stride of an animal with the elephant's hip
# height (gait.ts; species.ts hipFraction, the hip joint at 0.56 of the drawn height): 1.54 m at a
# walk of 1.2 m/s. In the 0.65 of it a foot is down the ground passes 1.0 m, and the sole of a leg
# 1.29 m long sweeps 2 x 1.29 x sin 26 less the pad's turn, 0.99 m: the planted feet keep pace.
SWING = 26.0
ROLL = 0.25

def local_axis(bone_name: str, axis: Vector) -> Vector:
    """An armature-space axis expressed in a bone's own rest frame."""
    return (arm.data.bones[bone_name].matrix_local.to_3x3().inverted() @ axis).normalized()


def local_vector(bone_name: str, vector: Vector) -> Vector:
    return arm.data.bones[bone_name].matrix_local.to_3x3().inverted() @ vector


def new_action(name: str) -> bpy.types.Action:
    old = bpy.data.actions.get(name)
    if old is not None:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new(name)
    arm.animation_data.action = action
    return action


def reset_pose() -> None:
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()


def key(names, frame: int) -> None:
    for name in names:
        pb = arm.pose.bones[name]
        pb.keyframe_insert("rotation_quaternion", frame=frame)
        pb.keyframe_insert("location", frame=frame)


def rotate(name: str, axis: Vector, degrees: float) -> None:
    pb = arm.pose.bones[name]
    pb.rotation_quaternion = Quaternion(local_axis(name, axis), math.radians(degrees)) @ pb.rotation_quaternion


def leg_pose(phase: float, fore: bool) -> tuple[float, float, float]:
    """The upper leg's forward swing and the lower leg's and foot's turns on their parents
    (degrees, + forward) at a phase 0-1 of the leg's own cycle, its foot coming down at 0.

    An elephant stands on columns: a planted leg stays straight and turns as one about the
    shoulder or hip while the body passes over it, the broad pad rolling from heel to toe. In the
    swing the two ends differ. A foreleg bends a little forward at the elbow and folds back hard at
    the wrist, so the foot comes up behind with its sole showing, then unfolds to land flat. A
    hind leg bends back at the knee and lifts the foot low, its sole turned a little back.
    """
    def bump(x: float) -> float:  # 0 -> 1 -> 0 over x in 0-1
        return math.sin(math.pi * max(0.0, min(1.0, x)))

    if phase < STANCE:  # planted: straight, sweeping back under the moving body
        s = phase / STANCE
        swing = SWING * (1 - 2 * s)
        # The pad rolls: flat at mid-stance, landing on its heel and leaving from its toe; a
        # foreleg begins to fold at the wrist as the foot leaves.
        roll = -ROLL * swing
        peel = -10.0 * max(0.0, (s - 0.85) / 0.15) if fore else 0.0
        return swing, 0.0, roll + peel
    s = (phase - STANCE) / (1 - STANCE)  # in the air: lifts, reaches forward and unfolds
    ease = 0.5 - 0.5 * math.cos(math.pi * s)
    swing = -SWING + 2 * SWING * ease
    # The foot leaves at the stance's last turn and lands at its first; between, it folds.
    leaving, landing = ROLL * SWING - (10.0 if fore else 0.0), -ROLL * SWING
    carried = leaving + (landing - leaving) * ease
    if fore:
        return swing, 14.0 * bump(s), carried - 40.0 * bump(s / 0.8)
    return swing, -34.0 * bump(s / 0.9), carried + 20.0 * bump(s / 0.9)


def lowest_point() -> float:
    bpy.context.view_layer.update()
    evaluated = MESH.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    lowest = min((MESH.matrix_world @ v.co).z for v in mesh.vertices)
    evaluated.to_mesh_clear()
    return lowest


# The standing body, measured once: the ground, each shoulder's and hip's height above it, the
# length of a pad, and how far ahead of the root the shoulders are.
arm.animation_data.action = None
reset_pose()
GROUND = lowest_point()
WORLD = arm.matrix_world
PIVOT = {name: (WORLD @ arm.data.bones[upper].head_local).z - GROUND for name, (upper, _, _, _) in LEGS.items()}
_groups = {g.name: g.index for g in MESH.vertex_groups}
_forward_w = (WORLD.to_3x3() @ FORWARD).normalized()


def pad_half_length(foot: str) -> float:
    sole = [MESH.matrix_world @ v.co for v in MESH.data.vertices
            if (MESH.matrix_world @ v.co).z < GROUND + 0.1 and any(g.group == _groups[foot] and g.weight > 0.5 for g in v.groups)]
    along = [p.dot(_forward_w) for p in sole]
    return (max(along) - min(along)) / 2 if along else 0.0


PAD = {name: pad_half_length(foot) for name, (_, _, foot, _) in LEGS.items()}
SHOULDER_REACH = ((WORLD @ arm.data.bones["UpperLegFront.L"].head_local) - (WORLD @ arm.data.bones["Bone.001"].head_local)).dot(_forward_w)
print("BODY pivots", {k: round(v, 2) for k, v in PIVOT.items()}, "pads", {k: round(v, 2) for k, v in PAD.items()}, "shoulder reach", round(SHOULDER_REACH, 2))


def drop(name: str, swing: float) -> float:
    """How far a planted leg's shoulder or hip must sink, turned `swing` degrees from upright, for
    the edge of its pad to stay on the ground: a straight leg rises at both ends of its arc, the
    pad's tilt (all but its ROLL share of the swing) lowering heel or toe part of the way."""
    a = math.radians(abs(swing))
    return max(0.0, PIVOT[name] * (1 - math.cos(a)) - PAD[name] * math.sin((1 - ROLL) * a))


# ---- Walk -----------------------------------------------------------------------------------
FRAMES = 48
new_action("Walk")
everything = [pb.name for pb in arm.pose.bones]
for frame in range(FRAMES + 1):
    reset_pose()
    t = frame / FRAMES
    poses = {name: leg_pose((t + offset) % 1.0, name.startswith("fore")) for name, (_, _, _, offset) in LEGS.items()}
    planted = {name: ((t + offset) % 1.0) < STANCE for name, (_, _, _, offset) in LEGS.items()}
    # The body rides over its columns, the hips over the planted hind leg and the shoulders over
    # the planted foreleg: each sinks as its leg leans out and rises as it stands upright. While
    # both legs of a pair are down (one just landed, leaning out, the other still near upright)
    # the body sinks only as far as the more upright one allows, and the landing foot settles.
    def sink(pair):
        down = [drop(n, poses[n][0]) for n in pair if planted[n]]
        return min(down) if down else 0.0

    hip = sink(("hind_left", "hind_right"))
    shoulder = sink(("fore_left", "fore_right"))
    root = arm.pose.bones["Bone"]
    root.location = local_vector("Bone", UP * (-hip / ARMATURE_SCALE))
    # The shoulders dip further than the hips by tipping the back forward; the forelegs' swing is
    # taken back by the same tip, so they still lean as far as their own pose says.
    tip = -math.degrees(math.atan2(shoulder - hip, SHOULDER_REACH))
    rotate("Bone.001", SIDE, tip)
    for name, (upper, lower, foot, offset) in LEGS.items():
        swing, bend, turn = poses[name]
        rotate(upper, SIDE, swing - (tip if name.startswith("fore") else 0.0))
        rotate(lower, SIDE, bend)
        rotate(foot, SIDE, turn)
    # It rolls toward the side that bears it and swings its shoulders gently.
    rotate("Bone", FORWARD, 2.0 * math.sin(2 * math.pi * t))
    rotate("Bone.002", UP, 1.5 * math.sin(2 * math.pi * t + 0.8))
    rotate("Bone.003", SIDE, 3.0 * math.sin(2 * math.pi * t + 0.6))  # the head nods
    for name, degrees, lag in [("Bone.012", 6.0, 0.0), ("Bone.013", 8.0, 0.5), ("Bone.014", 10.0, 1.0)]:
        rotate(name, UP, degrees * math.sin(2 * math.pi * t - lag))  # the trunk swings
    rotate("Bone.004", UP, 7.0 * math.sin(2 * math.pi * t - 1.0))
    rotate("Bone.005", UP, -7.0 * math.sin(2 * math.pi * t - 1.0 - math.pi / 2))
    rotate("Tail", SIDE, 10.0 * math.sin(2 * math.pi * t))
    key(everything, frame)
print("WALK", FRAMES, "frames")

# ---- Drinking -------------------------------------------------------------------------------
FRAMES = 96
new_action("Drinking")
for frame in range(FRAMES + 1):
    reset_pose()
    t = frame / FRAMES
    ease = lambda x: 0.5 - 0.5 * math.cos(math.pi * max(0.0, min(1.0, x)))
    down = ease(t / 0.3) * (1 - ease((t - 0.45) / 0.2))      # reach down, hold, then leave the water
    curl = ease((t - 0.5) / 0.2) * (1 - ease((t - 0.8) / 0.2))  # curl up to the mouth, then back
    rotate("Bone.003", SIDE, -20.0 * down - 4.0 * curl)
    # Uncurl while the head lowers. On the shipped mesh this puts the trunk tip
    # at the 4 cm water plane, measured against the standing feet.
    for name, reach, roll in [("Bone.012", 10.0, 12.0), ("Bone.013", 22.0 * 10 / 18, 30.0), ("Bone.014", 26.0 * 10 / 18, 42.0)]:
        rotate(name, SIDE, reach * down + roll * curl)
    rotate("Bone.004", UP, 4.0 * math.sin(2 * math.pi * t * 2))
    rotate("Bone.005", UP, -4.0 * math.sin(2 * math.pi * t * 2))
    key(everything, frame)
print("DRINKING", FRAMES, "frames")

# ---- Death ----------------------------------------------------------------------------------
FRAMES = 48


def death_pose(t: float) -> None:
    reset_pose()
    sink = min(1.0, t / 0.4)                       # knees give first
    fall = max(0.0, min(1.0, (t - 0.25) / 0.6))
    fall = fall * fall * (3 - 2 * fall)
    for name, (upper, lower, foot, _) in LEGS.items():
        give = 30.0 * sink * (1 - fall) + 12.0 * fall
        if name.startswith("fore"):  # the elbow gives forward and the wrist folds back
            rotate(lower, SIDE, 0.5 * give)
            rotate(foot, SIDE, -give)
        else:  # the knee gives back
            rotate(lower, SIDE, -give)
        rotate(upper, SIDE, -8.0 * fall)
    rotate("Bone", FORWARD, 85.0 * fall)           # rolls onto its side
    rotate("Bone.003", SIDE, -10.0 * fall)
    for name in ("Bone.012", "Bone.013", "Bone.014"):
        rotate(name, SIDE, -12.0 * fall)


# Keep the body on the ground as it rolls: measure the posed mesh each frame (no action bound,
# so the pose is what is measured) and lower the root until its lowest point is the standing
# feet's level again.
arm.animation_data.action = None
reset_pose()
GROUND = lowest_point()
drops = []
for frame in range(FRAMES + 1):
    death_pose(frame / FRAMES)
    drops.append(lowest_point() - GROUND)
new_action("Death")
for frame in range(FRAMES + 1):
    death_pose(frame / FRAMES)
    arm.pose.bones["Bone"].location = local_vector("Bone", UP * (-drops[frame] / ARMATURE_SCALE))
    key(everything, frame)
print("DEATH", FRAMES, "frames, lowest drift", round(max(drops), 3), round(min(drops), 3))

# Export every action as its own clip, as the rig's other clips are.
arm.animation_data.action = None
for track in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(track)
for action in bpy.data.actions:
    track = arm.animation_data.nla_tracks.new()
    track.name = action.name
    strip = track.strips.new(action.name, int(action.frame_range[0]), action)
    strip.name = action.name
bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_image_format="WEBP",
                          export_draco_mesh_compression_enable=False, export_apply=False)
print(f"WROTE {args.out}", [a.name for a in bpy.data.actions])
