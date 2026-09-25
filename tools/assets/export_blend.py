"""Run with Blender --background --disable-autoexec INPUT.blend --python this.py -- OUTPUT.glb.

Converts licensed source art locally. Never executes scripts embedded in downloaded .blend
files. Preserves the author's skin/animations; no invented animation claims.
"""
import bpy
import sys

output = sys.argv[sys.argv.index('--') + 1]
is_rabbit = 'Rabbit' in bpy.data.objects and 'rabbot-skinn' in bpy.data.images
if is_rabbit:
    # This source scene contains a modelling floor, not part of the character.
    floor = bpy.data.objects.get('Plane')
    if floor is not None:
        bpy.data.objects.remove(floor, do_unlink=True)
for material in bpy.data.materials:
    if not material.use_nodes:
        color = tuple(material.diffuse_color)
        material.use_nodes = True
        shader = material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value = color
        shader.inputs['Roughness'].default_value = 0.85
    if is_rabbit and material.name in {'Fur', 'Fur.001'}:
        nodes = material.node_tree.nodes
        shader = nodes.get('Principled BSDF')
        texture = nodes.new('ShaderNodeTexImage')
        texture.image = bpy.data.images['Fur-skin' if material.name == 'Fur' else 'rabbot-skinn']
        material.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        if material.name == 'Fur':
            material.blend_method = 'CLIP'
            material.alpha_threshold = 0.5
            material.node_tree.links.new(texture.outputs['Alpha'], shader.inputs['Alpha'])
        else:
            normal = nodes.new('ShaderNodeTexImage')
            normal.image = bpy.data.images['rabbit-NORM']
            normal.image.colorspace_settings.name = 'Non-Color'
            normal_map = nodes.new('ShaderNodeNormalMap')
            material.node_tree.links.new(normal.outputs['Color'], normal_map.inputs['Color'])
            material.node_tree.links.new(normal_map.outputs['Normal'], shader.inputs['Normal'])

for obj in bpy.data.objects:
    if obj.type not in {'MESH', 'ARMATURE'}:
        bpy.data.objects.remove(obj, do_unlink=True)
    elif obj.type == 'MESH':
        obj.data.validate()

if is_rabbit:
    aliases = {'Running': 'Gallop', 'Guarding': 'Idle', 'Sitting.000': 'Resting', 'Dying.000': 'Death'}
    for original, alias in aliases.items():
        if original in bpy.data.actions:
            bpy.data.actions[original].name = alias
for obj in bpy.data.objects:
    if obj.type == 'ARMATURE' and 'Idle' in bpy.data.actions:
        obj.animation_data_create()
        obj.animation_data.action = bpy.data.actions['Idle']

bpy.context.scene.frame_set(0)
bpy.ops.export_scene.gltf(
    filepath=output, export_format='GLB', export_animations=True,
    export_force_sampling=True, export_frame_range=False,
    export_cameras=False, export_lights=False, export_skins=True,
    export_yup=True,
)
print('Exported', output)
