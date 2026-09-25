"""Read-only Poly Haven scene inventory. Use --background --disable-autoexec --python-exit-code 1."""
import bpy
import json

def modifier(m):
    result = {'name': m.name, 'type': m.type, 'viewport': m.show_viewport, 'render': m.show_render}
    if m.type == 'NODES' and m.node_group:
        result['group'] = m.node_group.name
        result['inputs'] = [{'name': i.name, 'identifier': i.identifier,
                             'value': str(m.get(i.identifier, getattr(i, 'default_value', '')))}
                            for i in m.node_group.interface.items_tree
                            if i.item_type == 'SOCKET' and i.in_out == 'INPUT']
    return result

print('TREE_SOURCE_INVENTORY', json.dumps({
    'version': bpy.app.version_string,
    'objects': [{'name': o.name, 'type': o.type, 'hidden': o.hide_render,
                 'dimensions': list(o.dimensions), 'polygons': len(o.data.polygons) if o.type == 'MESH' else 0,
                 'modifiers': [modifier(m) for m in o.modifiers]} for o in bpy.data.objects],
    'collections': [{'name': c.name, 'objects': [o.name for o in c.objects]} for c in bpy.data.collections],
    'materials': [{'name': m.name, 'nodes': [{'name': n.name, 'type': n.type,
                   'image': n.image.filepath if n.type == 'TEX_IMAGE' and n.image else None}
                  for n in m.node_tree.nodes] if m.node_tree else []} for m in bpy.data.materials],
    'images': [{'name': i.name, 'filepath': i.filepath, 'size': list(i.size)} for i in bpy.data.images],
}, default=str))
