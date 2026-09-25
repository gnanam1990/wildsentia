"""Read-only GLB pose render: INPUT OUTPUT [MESH_NAME] [CLIP] [FRAME] [CAMERA_YAW_DEGREES].
Run official Blender with --factory-startup --disable-autoexec --python-exit-code 1.
Only selected mesh geometry is framed; source files are never saved or overwritten.
"""
import bpy
import sys
import math
from pathlib import Path
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, output = args[:2]
mesh_name = args[2] if len(args) > 2 and args[2] != '-' else None
clip = args[3] if len(args) > 3 else 'Idle'
frame = float(args[4]) if len(args) > 4 else 0
camera_yaw = float(args[5]) if len(args) > 5 else 0
if Path(output).exists() or Path(output).resolve() == Path(source).resolve():
    raise RuntimeError('Review output must be a new file')
if not math.isfinite(frame) or frame < 0 or not math.isfinite(camera_yaw):
    raise RuntimeError('Invalid frame or camera yaw')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
for obj in bpy.data.objects:
    if obj.type == 'ARMATURE':
        if obj.animation_data:
            for track in obj.animation_data.nla_tracks:
                track.mute = True
        action = bpy.data.actions.get(clip)
        if not action:
            raise RuntimeError('Missing review clip: ' + clip)
        if action:
            obj.animation_data_create()
            obj.animation_data.action = action
            if len(action.slots):
                obj.animation_data.action_slot = action.slots[0]
bone_shapes = {bone.custom_shape for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'
               for bone in obj.pose.bones if bone.custom_shape}
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in bone_shapes
          and (o.name == mesh_name if mesh_name else not o.hide_render)]
if not meshes:
    raise RuntimeError('No review mesh')
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH' and obj not in meshes:
        obj.hide_render = True
bpy.context.scene.frame_set(int(frame), subframe=frame % 1)
bpy.context.view_layer.update()
graph = bpy.context.evaluated_depsgraph_get()
points = [o.matrix_world @ v.co for obj in meshes for o in [obj.evaluated_get(graph)] for v in o.data.vertices]
minimum = Vector(tuple(min(p[i] for p in points) for i in range(3)))
maximum = Vector(tuple(max(p[i] for p in points) for i in range(3)))
center = (minimum + maximum) / 2
extent = max(maximum - minimum)
if not all(math.isfinite(v) for point in points for v in point) or extent <= 0:
    raise RuntimeError('Invalid review geometry bounds')
print('REVIEW_BOUNDS', list(minimum), list(maximum), 'mesh', [o.name for o in meshes])
bpy.ops.mesh.primitive_plane_add(size=extent * 12, location=(center.x, center.y, minimum.z - extent * .003))
mat = bpy.data.materials.new('Review floor')
mat.diffuse_color = (.20, .22, .20, 1)
bpy.context.object.data.materials.append(mat)
scene = bpy.context.scene
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.65, .70, .75, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .6
for offset, strength, size in [((1, -1, 2), 170, 2), ((-1, 1, 1), 90, 1.5)]:
    bpy.ops.object.light_add(type='AREA', location=center + Vector(offset) * extent)
    light = bpy.context.object
    light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    light.data.energy = strength * extent * extent
    light.data.size = size * extent
view = Matrix.Rotation(math.radians(camera_yaw), 3, 'Z') @ Vector((1.2, -1.8, .75))
bpy.ops.object.camera_add(location=center + view * extent)
camera = bpy.context.object
camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = extent * 1.5
camera.data.clip_start = extent * .001
camera.data.clip_end = extent * 100
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x = 1000
scene.render.resolution_y = 750
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = output
bpy.ops.render.render(write_still=True)
