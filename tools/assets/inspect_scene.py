"""Read-only scene inspection. Run Blender with --disable-autoexec."""
import bpy
import json
import sys

if '--' in sys.argv:
    source = sys.argv[sys.argv.index('--') + 1]
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=source)
print(json.dumps({
    'objects': [{'name': o.name, 'type': o.type, 'dimensions': list(o.dimensions),
                 'location': list(o.location), 'rotation': list(o.rotation_euler)} for o in bpy.data.objects],
    'actions': [{'name': a.name, 'frames': list(a.frame_range)} for a in bpy.data.actions],
    'materials': [m.name for m in bpy.data.materials],
    'images': [{'name': i.name, 'size': list(i.size)} for i in bpy.data.images],
    'bones': {o.name: [{'name': b.name, 'parent': b.parent.name if b.parent else None,
                       'head': list(b.head_local), 'tail': list(b.tail_local)} for b in o.data.bones]
              for o in bpy.data.objects if o.type == 'ARMATURE'},
}))
