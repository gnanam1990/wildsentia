"""Stands a generated four-legged mesh square: each leg turned upright under its shoulder or hip.

    Blender -b --python tools/art/square_stance.py -- --in elephant-tripo.glb --out elephant-square.glb

A generated mesh can come out mid-stride (the forest elephant's did: its left hind foot a third
of the body behind its right, its forefeet apart too), while the rigs stand square, every leg
straight down. Bound as it is, each leg sits off its bone and swings about the wrong point, and
the animal stands mid-step at rest. Here the four feet are found as the clusters of the lowest
surface (the lowest 5%, below a trunk that hangs nearly to the ground), the hind and front pairs
split at the widest gap between them along the body. Each leg turns about the side axis through a
pivot at shoulder (or hip) height above its pair's mean position until its foot stands there. The
turn fades out up the leg into the body, so the shoulders and hips are untouched. The mesh faces
+X, as Tripo's do.
"""
import argparse
import math
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--in", dest="src", required=True)
parser.add_argument("--out", required=True)
# Shoulder and hip height as a share of the body's height, and the share of the leg (from the
# pivot down) over which the turn fades in.
parser.add_argument("--pivot", type=float, default=0.58)
parser.add_argument("--fade", type=float, default=0.45)
args = parser.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args.src)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
points = [(o, v, o.matrix_world @ v.co) for o in meshes for v in o.data.vertices]
lo = min(p.z for _, _, p in points)
hi = max(p.z for _, _, p in points)
height = hi - lo

# ---- The four feet ---------------------------------------------------------------------------
low = [p for _, _, p in points if p.z < lo + 0.05 * height]
xs = sorted(p.x for p in low)
gap_at = max(range(1, len(xs)), key=lambda i: xs[i] - xs[i - 1])
split_x = (xs[gap_at - 1] + xs[gap_at]) / 2
mid_y = sum(p.y for p in low) / len(low)
feet = {}
for pair, in_pair in (("hind", lambda p: p.x < split_x), ("fore", lambda p: p.x >= split_x)):
    for side, on_side in (("left", lambda p: p.y > mid_y), ("right", lambda p: p.y <= mid_y)):
        cluster = [p for p in low if in_pair(p) and on_side(p)]
        centre = sum(cluster, Vector()) / len(cluster)
        radius = max(math.hypot(p.x - centre.x, p.y - centre.y) for p in cluster)
        feet[(pair, side)] = (centre, radius)

# ---- Turn each leg upright -------------------------------------------------------------------
pivot_z = lo + args.pivot * height
legs = []
for (pair, side), (foot, radius) in feet.items():
    mate = feet[(pair, "right" if side == "left" else "left")][0]
    pivot = Vector(((foot.x + mate.x) / 2, foot.y, pivot_z))
    down = foot - pivot
    angle = math.atan2(down.x, -down.z)  # the turn about +Y that brings the foot under the pivot
    legs.append((pair, side, foot, radius, pivot, angle))
    print(f"LEG {pair} {side}: foot x {foot.x:+.3f} y {foot.y:+.3f}, pivot x {pivot.x:+.3f}, turn {math.degrees(angle):+.1f} deg")


def leg_weight(p: Vector, foot: Vector, radius: float, pivot: Vector) -> float:
    """How fully a surface point turns with this leg: 1 low on the leg, fading to 0 at the pivot."""
    if p.z >= pivot.z:
        return 0.0
    # Distance from the line pivot -> foot at this height, in the ground plane.
    t = (pivot.z - p.z) / (pivot.z - foot.z)
    on_line = pivot.lerp(foot, t)
    off = math.hypot(p.x - on_line.x, p.y - on_line.y)
    reach = radius * 1.35
    if off > reach:
        return 0.0
    side = 1.0 if off < radius else 1.0 - (off - radius) / (reach - radius)
    up = min(1.0, t / args.fade)
    up = up * up * (3 - 2 * up)
    return side * up


moved = 0
for obj, vertex, p in points:
    best = None
    for pair, side, foot, radius, pivot, angle in legs:
        w = leg_weight(p, foot, radius, pivot)
        if w > 0 and (best is None or w > best[0]):
            best = (w, pivot, angle)
    if best is None:
        continue
    w, pivot, angle = best
    turn = Matrix.Rotation(angle * w, 3, "Y")
    q = pivot + turn @ (p - pivot)
    vertex.co = obj.matrix_world.inverted() @ q
    moved += 1
print(f"SQUARED {moved} of {len(points)} vertices")

bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_image_format="WEBP",
                          export_draco_mesh_compression_enable=False)
print(f"WROTE {args.out}")
