"""An interim island leopard from the project's own rigged tiger: same big-cat rig and clips,
the coat repainted from stripes to rosettes. Never modifies the source GLB.

  blender -b --factory-startup --disable-autoexec --python tools/assets/leopard_from_tiger.py -- \
    packages/client/public/assets/animals/TigerRigged.glb OUT_DIR

Leopards and tigers share the big-cat build, but a leopard is slighter, with a longer tail and a
golden coat of rosettes. Size comes from the species' height in the client; the proportions stay
the tiger's until a leopard-specific mesh exists, and the client says so.

The coat: the tiger's dark stripes are found by luminance and filled from the fur around them
(a masked blur, with the fur's fine detail kept), the orange is warmed toward a leopard's golden
tawny, and rosettes are painted in texture space: broken rings of black spots round a slightly
darker centre on the tawny fur, solid spots on the white underside and legs. Deterministic.
"""
import math
import os
import sys

import bpy
import numpy as np

src, out_dir = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(out_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for stray in [o for o in bpy.data.objects if o.name == "Icosphere"]:
    bpy.data.objects.remove(stray)

# The base colour image feeds the principled BSDF's Base Color.
base = None
for material in bpy.data.materials:
    if not material.use_nodes:
        continue
    for link in material.node_tree.links:
        if link.from_node.type == "TEX_IMAGE" and link.to_socket.name == "Base Color":
            base = link.from_node.image
if base is None:
    raise SystemExit("no base colour texture found")
w, h = base.size
px = np.array(base.pixels[:], dtype=np.float32).reshape(h, w, 4)
rgb = px[..., :3].copy()


def blur(a, sigma):
    """Gaussian blur by FFT, wrapping at the edges (fine for an atlas of padded islands)."""
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    kernel = np.exp(-2 * (math.pi * sigma) ** 2 * (fx * fx + fy * fy))
    if a.ndim == 2:
        return np.real(np.fft.ifft2(np.fft.fft2(a) * kernel))
    return np.stack([blur(a[..., c], sigma) for c in range(a.shape[2])], axis=-1)


lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
# Stripes: dark marks, with a soft edge so the fill blends.
stripe = np.clip((0.46 - lum) / 0.16, 0, 1)
stripe = np.clip(blur(stripe, 2.5) * 1.6, 0, 1)
keep = 1 - stripe

# Fill each stripe with the colour of the fur around it.
fill = blur(rgb * keep[..., None], 14) / np.maximum(blur(keep, 14), 1e-4)[..., None]
# Keep the fur's fine detail: the ratio of each pixel to its neighbourhood, where it is fur.
detail = np.where(keep > 0.9, lum / np.maximum(blur(lum, 3), 1e-3), 1.0)
detail = np.clip(blur(detail, 0.6), 0.8, 1.2)
coat = rgb * keep[..., None] + fill * stripe[..., None] * detail[..., None]

# Tawny areas (orange fur) versus the white underside.
r, g, b = coat[..., 0], coat[..., 1], coat[..., 2]
warmth = np.clip((r - b) / np.maximum(r, 1e-3), 0, 1)
tawny = np.clip((warmth - 0.25) / 0.2, 0, 1)
# Warm orange toward golden: a little more green, slightly lighter and less saturated.
golden = np.stack([r * 1.05, g * 1.05 + 0.01, b * 0.92], axis=-1)
coat = coat * (1 - tawny[..., None]) + np.clip(golden, 0, 1) * tawny[..., None]

# The tiger's tail sits in a pale part of the texture; a leopard's tail is tawny and spotted.
# Find the tail's texture area from the faces skinned to the tail bones, and colour it like the body.
mesh = next(o for o in bpy.data.objects if o.type == "MESH")
tail_groups = {g.index for g in mesh.vertex_groups if g.name.startswith("tail")}
tail_weight = np.zeros(len(mesh.data.vertices), dtype=np.float32)
for v in mesh.data.vertices:
    tail_weight[v.index] = sum(g.weight for g in v.groups if g.group in tail_groups)
uv_layer = mesh.data.uv_layers.active.data
tail = np.zeros((h, w), dtype=np.float32)
steps = np.linspace(0, 1, 12)
for poly in mesh.data.polygons:
    if tail_weight[list(poly.vertices)].mean() < 0.5:
        continue
    uvs = np.array([uv_layer[i].uv[:] for i in poly.loop_indices])
    for k in range(1, len(uvs) - 1):  # fan triangles
        a0, a1, a2 = uvs[0], uvs[k], uvs[k + 1]
        for s1 in steps:
            for s2 in steps:
                if s1 + s2 > 1:
                    continue
                u, v = a0 + (a1 - a0) * s1 + (a2 - a0) * s2
                tail[int(min(h - 1, max(0, v * h))), int(min(w - 1, max(0, u * w)))] = 1
tail = np.clip(blur(tail, 3) * 4, 0, 1)
body_tawny = np.median(coat[tawny > 0.9], axis=0)
tail_lum = coat @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
tail_coat = body_tawny[None, None, :] * np.clip(tail_lum / max(tail_lum[tail > 0.5].mean(), 1e-3), 0.75, 1.15)[..., None]
coat = coat * (1 - tail[..., None]) + tail_coat * tail[..., None]
tawny = np.maximum(tawny, tail)

# Rosettes and spots, on a jittered grid in texture space.
rng = np.random.default_rng(1977)
spacing = 54
yy, xx = np.mgrid[0:h, 0:w]
ink = np.zeros((h, w), dtype=np.float32)    # black of the spots
centre = np.zeros((h, w), dtype=np.float32) # the darker inside of a rosette


def stamp(layer, cx, cy, radius, strength):
    x0, x1 = max(0, int(cx - radius - 2)), min(w, int(cx + radius + 3))
    y0, y1 = max(0, int(cy - radius - 2)), min(h, int(cy + radius + 3))
    if x0 >= x1 or y0 >= y1:
        return
    d = np.hypot(xx[y0:y1, x0:x1] - cx, yy[y0:y1, x0:x1] - cy)
    layer[y0:y1, x0:x1] = np.maximum(layer[y0:y1, x0:x1], strength * np.clip(radius + 0.8 - d, 0, 1))


for gy in range(0, h, spacing):
    for gx in range(0, w, spacing):
        cx = gx + spacing / 2 + rng.uniform(-0.3, 0.3) * spacing
        cy = gy + spacing / 2 + rng.uniform(-0.3, 0.3) * spacing
        ix, iy = int(min(w - 1, max(0, cx))), int(min(h - 1, max(0, cy)))
        if tawny[iy, ix] > 0.5:
            # A rosette: four to six black spots on a broken ring, gaps between them.
            ring = rng.uniform(13, 17)
            n = int(rng.integers(5, 8))
            turn = rng.uniform(0, 2 * math.pi)
            for k in range(n):
                if rng.random() < 0.2:
                    continue
                a = turn + 2 * math.pi * k / n + rng.uniform(-0.25, 0.25)
                stamp(ink, cx + ring * math.cos(a), cy + ring * math.sin(a), rng.uniform(4.5, 6.5), 1.0)
            stamp(centre, cx, cy, ring - 3, 1.0)
        else:
            # The pale underside and legs carry solid spots.
            stamp(ink, cx, cy, rng.uniform(4, 6.5), 0.9)

ink = np.clip(blur(ink, 0.8), 0, 1)
centre = np.clip(blur(centre, 1.5), 0, 1) * (1 - ink)
spot_colour = np.array([0.06, 0.045, 0.03], dtype=np.float32)
coat = coat * (1 - 0.22 * centre[..., None])
coat = coat * (1 - ink[..., None]) + spot_colour * ink[..., None]

px[..., :3] = np.clip(coat, 0, 1)
leopard = bpy.data.images.new("LeopardCoat", width=w, height=h, alpha=True)
leopard.pixels[:] = px.ravel()
leopard.filepath_raw = os.path.join(out_dir, "LeopardCoat.png")
leopard.file_format = "PNG"
leopard.save()
for material in bpy.data.materials:
    if not material.use_nodes:
        continue
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image == base:
            node.image = leopard

for obj in bpy.data.objects:
    if obj.type == "ARMATURE":
        obj.name = "LeopardRig"
    elif obj.type == "MESH":
        obj.name = "LeopardMesh"
out = os.path.join(out_dir, "LeopardRigged.glb")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True,
                          export_animation_mode="ACTIONS", export_image_format="JPEG",
                          export_draco_mesh_compression_enable=False, export_apply=False)
print(f"WROTE {out}")
