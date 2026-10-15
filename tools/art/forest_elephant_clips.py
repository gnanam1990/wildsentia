"""Builds the forest elephant's Walk, Drinking and Death clips on its rig.

    Blender -b --python tools/art/forest_elephant_clips.py -- --in ForestElephant.glb --out ForestElephant.glb

The generic elephant rig (OpenGameArt, CC0) walks with its legs barely lifting, has no drinking
clip (its Eating raises the trunk into the branches) and no death. Keyframed here, not motion
capture, from the rig's rest pose, which stands square:
- Walk (2 s): a lateral-sequence walk (left hind, left fore, right hind, right fore a quarter
  cycle apart). Each leg swings about 20 degrees and, while it swings forward, bends at the knee
  and lifts its foot. The body bobs twice a cycle; the head nods, the trunk swings and the ears
  move once a cycle (a second beat in the clip would read as two strides to the game's gait
  clock, gait.ts strideCycles).
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

# The armature object is turned in the file (about 71 degrees about X), so the animal's axes are
# taken from the world: up is world +Z, forward runs from the root to the head bone, and the side
# axis is their cross product, toward the animal's right. A positive turn about it swings a
# hanging leg forward and tips the head up. All three are in armature space, where the bones live.
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
STANCE = 0.65  # share of the cycle a foot is on the ground


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


def leg_angles(phase: float) -> tuple[float, float]:
    """Forward swing of the upper leg (degrees, + forward) and knee bend (degrees) at a phase 0-1."""
    amplitude = 20.0
    if phase < STANCE:  # foot planted: the leg sweeps back under the moving body
        s = phase / STANCE
        return amplitude * (1 - 2 * s), 0.0
    s = (phase - STANCE) / (1 - STANCE)  # swing: lifts, bends and reaches forward
    return -amplitude + 2 * amplitude * (0.5 - 0.5 * math.cos(math.pi * s)), 38.0 * math.sin(math.pi * s)


# ---- Walk -----------------------------------------------------------------------------------
FRAMES = 48
new_action("Walk")
everything = [pb.name for pb in arm.pose.bones]
for frame in range(FRAMES + 1):
    reset_pose()
    t = frame / FRAMES
    for upper, lower, foot, offset in LEGS.values():
        swing, bend = leg_angles((t + offset) % 1.0)
        # The swinging leg reaches forward while its knee (or wrist) folds the foot back and up.
        rotate(upper, SIDE, swing)
        rotate(lower, SIDE, -bend)
        rotate(foot, SIDE, bend * 0.6 - swing * 0.5)
    # The body bobs twice a stride (each pair of feet) and rocks a little side to side.
    root = arm.pose.bones["Bone"]
    root.location = local_vector("Bone", UP * (0.06 * math.cos(4 * math.pi * t)))
    rotate("Bone", FORWARD, 1.5 * math.sin(2 * math.pi * t))
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
    rotate("Bone.003", SIDE, -12.0 * down - 4.0 * curl)       # head dips toward the water
    for name, reach, roll in [("Bone.012", -18.0, 12.0), ("Bone.013", -22.0, 30.0), ("Bone.014", -26.0, 42.0)]:
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
    for upper, lower, foot, _ in LEGS.values():
        rotate(lower, SIDE, -(30.0 * sink * (1 - fall) + 12.0 * fall))
        rotate(upper, SIDE, -8.0 * fall)
    rotate("Bone", FORWARD, 85.0 * fall)           # rolls onto its side
    rotate("Bone.003", SIDE, -10.0 * fall)
    for name in ("Bone.012", "Bone.013", "Bone.014"):
        rotate(name, SIDE, -12.0 * fall)


def lowest_point() -> float:
    bpy.context.view_layer.update()
    evaluated = MESH.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    lowest = min((MESH.matrix_world @ v.co).z for v in mesh.vertices)
    evaluated.to_mesh_clear()
    return lowest


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
