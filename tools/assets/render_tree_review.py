"""Render two exported GLBs together for visual QA. No source edits.
blender -b --factory-startup --disable-autoexec --python this.py -- A.glb B.glb review.png
"""
import bpy
import math
import sys
from mathutils import Vector

first, second, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for source, x in [(first, -5.0), (second, 5.0)]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=source)
    for obj in set(bpy.data.objects) - before:
        if obj.parent is None:
            obj.location.x += x

bpy.ops.mesh.primitive_plane_add(size=100)
ground = bpy.context.object
mat = bpy.data.materials.new('Neutral review floor')
mat.diffuse_color = (0.16, 0.17, 0.14, 1)
ground.data.materials.append(mat)

world = bpy.context.scene.world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.65, 0.75, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
bpy.ops.object.light_add(type='AREA', location=(0, -8, 18))
bpy.context.object.data.energy = 2600
bpy.context.object.data.shape = 'DISK'
bpy.context.object.data.size = 12
bpy.ops.object.camera_add(location=(12, -27, 13))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 3.8)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 25
scene = bpy.context.scene
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1400
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = output
bpy.ops.render.render(write_still=True)
