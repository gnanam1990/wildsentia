"""Add a locally authored walk to syncopika's CC0 elephant, preserving source clips.

Run: blender -b --factory-startup --disable-autoexec --python extend_elephant.py -- INPUT.glb OUTPUT.glb
This is a stylized gait, not validated biomechanical motion capture.
"""
import bpy
import math
import sys
from mathutils import Vector, Quaternion

source, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for action in bpy.data.actions:
    if action.name.endswith('_' + rig.name):
        action.name = action.name[:-(len(rig.name)+1)]
    action.use_fake_user = True
rig.animation_data.action = bpy.data.actions['Idle']
for track in rig.animation_data.nla_tracks:
    track.mute = True
bpy.context.scene.frame_set(0)
base = {p.name: (p.location.copy(), p.rotation_quaternion.copy(), p.scale.copy()) for p in rig.pose.bones}
axes = {p.name: (rig.matrix_world @ p.matrix).to_quaternion().inverted() @ Vector((1,0,0)) for p in rig.pose.bones}
walk = bpy.data.actions.new('Walk')
walk.use_fake_user = True
rig.animation_data.action = walk
phases = [('Front.L',0), ('Back.L',math.pi/2), ('Front.L.001',math.pi), ('Back.L.001',3*math.pi/2)]
for frame in range(49):
    t = frame / 48 * math.pi * 2
    for p in rig.pose.bones:
        p.rotation_mode = 'QUATERNION'
        p.location, p.rotation_quaternion, p.scale = base[p.name]
    for suffix, phase in phases:
        v = math.sin(t+phase)
        for prefix, angle in [('UpperLeg',0.17*v), ('LowerLeg',-0.12*max(0,v)), ('Foot',-0.06*v)]:
            p = rig.pose.bones[prefix+suffix]
            p.rotation_quaternion = base[p.name][1] @ Quaternion(axes[p.name],angle)
    for name, amplitude in [('Tail',0.05), ('Bone.012',0.025), ('Bone.013',0.03), ('Bone.014',0.035)]:
        p = rig.pose.bones.get(name)
        if p:
            p.rotation_quaternion = base[name][1] @ Quaternion(axes[name],math.sin(t)*amplitude)
    for p in rig.pose.bones:
        p.keyframe_insert('location',frame=frame)
        p.keyframe_insert('rotation_quaternion',frame=frame)
        p.keyframe_insert('scale',frame=frame)
for f in walk.fcurves:
    for key in f.keyframe_points:
        key.interpolation = 'LINEAR'
rig.animation_data.action = bpy.data.actions['Idle']
bpy.context.scene.frame_set(0)
bpy.context.scene.render.fps = 24
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_animations=True,
                          export_force_sampling=True, export_frame_range=False, export_skins=True,
                          export_cameras=False, export_lights=False)
