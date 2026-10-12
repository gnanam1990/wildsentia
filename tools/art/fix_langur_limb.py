"""Removes the fifth limb the generated grey-langur mesh grew under its chest.

The Tripo mesh behind GreyLangur.glb came out with an extra arm-like limb on its left side,
between the stretched-forward left arm and the striding left hind leg, bound to the front-left
arm bones, so it swung like a fifth leg. Below the chest it is a separate column of geometry
(z < 0.36, x < -0.1, y -0.36..-0.18 in the rig's rest pose); above that it joins the chest. Its vertices
are folded up inside the chest and given the weights of the nearest chest vertex, so nothing
hangs or swings there; no hole is cut and the texture is untouched.

  blender -b --factory-startup --python tools/art/fix_langur_limb.py -- IN.glb OUT.glb
"""
import sys

import bpy
import numpy as np
from mathutils import Vector

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
# Some Blender startups leave a stray Icosphere; it is not part of the model.
for stray in [o for o in bpy.data.objects if o.name == "Icosphere"]:
    bpy.data.objects.remove(stray)
mesh = next(o for o in bpy.data.objects if o.type == "MESH" and o.name != "Icosphere")
world = mesh.matrix_world
inverse = world.inverted()
P = np.array([tuple(world @ v.co) for v in mesh.data.vertices])

JOIN_Z, Y_FROM, Y_TO = 0.36, -0.36, -0.18
limb = np.where((P[:, 2] < JOIN_Z) & (P[:, 1] > Y_FROM) & (P[:, 1] < Y_TO) & (P[:, 0] < -0.1))[0]
if len(limb) == 0:
    raise SystemExit("no extra limb found: already fixed?")
print(f"LIMB {len(limb)} vertices, x {P[limb, 0].min():.3f}..{P[limb, 0].max():.3f}")

# Chest vertices just above the join, outside the limb: where the folded limb is tucked away.
chest = np.where((P[:, 2] > JOIN_Z + 0.02) & (P[:, 2] < JOIN_Z + 0.12)
                 & (P[:, 1] > Y_FROM - 0.05) & (P[:, 1] < Y_TO + 0.05))[0]
centre = P[chest].mean(0)
inside = Vector((centre[0], centre[1], centre[2] + 0.08))
groups = {g.index: g for g in mesh.vertex_groups}
for i in map(int, limb):
    v = mesh.data.vertices[i]
    p = Vector(P[i])
    # Folded to a twentieth of its size round a point well inside the chest.
    v.co = inverse @ (inside + (p - Vector(centre)) * 0.05)
    nearest = int(chest[np.argmin(np.linalg.norm(P[chest] - P[i], axis=1))])
    weights = [(g.group, g.weight) for g in mesh.data.vertices[nearest].groups]
    for g in list(v.groups):
        groups[g.group].remove([i])
    for group, weight in weights:
        groups[group].add([i], weight, "REPLACE")

bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True,
                          export_animation_mode="ACTIONS", export_image_format="WEBP",
                          export_draco_mesh_compression_enable=False, export_apply=False)
print(f"WROTE {out}")
