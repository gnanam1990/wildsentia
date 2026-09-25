"""Build a web-sized derivative of two reviewed Poly Haven CC0 tree sources.

Blender 4.5.9: -b --factory-startup --disable-autoexec INPUT.blend
  --python-exit-code 1 --python tools/assets/export_natural_tree.py -- ASSET_ID OUTPUT.glb
Never saves over a source .blend. No embedded scripts, paid services or invented species labels.
"""
import bpy
import json
from pathlib import Path
import struct
import sys
import numpy as np
from mathutils import Vector

asset_id, output = sys.argv[sys.argv.index('--') + 1:]
if asset_id not in {'island_tree_02', 'tree_small_02'}:
    raise ValueError('Unreviewed source')
source_root = Path(bpy.data.filepath).resolve().parent
for image in bpy.data.images:
    if image.source == 'FILE':
        path = Path(bpy.path.abspath(image.filepath)).resolve()
        if not path.is_relative_to(source_root) or not path.is_file():
            raise ValueError(f'Unexpected or missing source texture: {path}')

def in_scene(obj):
    if obj.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(obj)
    obj.hide_set(False)
    obj.hide_viewport = False

def triangle_count(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)

def reduce_mesh(obj, target):
    before = triangle_count(obj.data)
    if before <= target:
        return
    in_scene(obj)
    modifier = obj.modifiers.new('VANA web reduction', 'DECIMATE')
    modifier.ratio = target / before
    modifier.use_collapse_triangulate = True
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True,
                                          depsgraph=bpy.context.evaluated_depsgraph_get())
    obj.modifiers.clear()
    obj.data = mesh

def leaf_cards(obj):
    """Fit each disconnected leaf to its own UV-preserving cutout card.

    A budget over an entire branch silently deletes the smallest leaves. Independent
    cards preserve every component instead. Non-planar stems retain their original
    geometry rather than being projected through an ill-conditioned UV fit.
    """
    mesh = obj.data
    uv = mesh.uv_layers.active
    adjacency = [set() for _ in mesh.vertices]
    for edge in mesh.edges:
        a, b = edge.vertices
        adjacency[a].add(b)
        adjacency[b].add(a)
    unseen = set(range(len(mesh.vertices)))
    components = []
    while unseen:
        start = min(unseen)
        unseen.remove(start)
        todo, group = [start], {start}
        while todo:
            for neighbour in sorted(adjacency[todo.pop()]):
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    group.add(neighbour)
                    todo.append(neighbour)
        components.append(group)
    vertices, faces, face_uvs = [], [], []
    cards = 0
    for group in components:
        polygons = [p for p in mesh.polygons if p.vertices[0] in group]
        loops = [i for p in polygons for i in p.loop_indices]
        coords = np.array([mesh.vertices[mesh.loops[i].vertex_index].co[:] for i in loops])
        texcoords = np.array([uv.data[i].uv[:] for i in loops])
        design = np.column_stack((texcoords, np.ones(len(loops))))
        fit, _, rank, _ = np.linalg.lstsq(design, coords, rcond=None)
        extent = np.linalg.norm(np.ptp(coords, axis=0))
        error = np.max(np.linalg.norm(design @ fit - coords, axis=1))
        if rank == 3 and extent > 0 and error < extent * 0.18:
            lo, hi = texcoords.min(axis=0), texcoords.max(axis=0)
            corners = [(lo[0], lo[1]), (hi[0], lo[1]), (hi[0], hi[1]), (lo[0], hi[1])]
            base = len(vertices)
            vertices.extend((np.array([u, v, 1.0]) @ fit).tolist() for u, v in corners)
            faces.append(tuple(range(base, base + 4)))
            face_uvs.append(corners)
            cards += 1
        else:
            indices = {v: len(vertices) + i for i, v in enumerate(sorted(group))}
            vertices.extend(mesh.vertices[v].co[:] for v in sorted(group))
            for polygon in polygons:
                faces.append(tuple(indices[v] for v in polygon.vertices))
                face_uvs.append([uv.data[i].uv[:] for i in polygon.loop_indices])
    result = bpy.data.meshes.new(obj.name + ' cutout cards')
    result.from_pydata(vertices, [], faces)
    for material in mesh.materials:
        result.materials.append(material)
    layer = result.uv_layers.new(name=uv.name)
    for polygon, values in zip(result.polygons, face_uvs):
        for index, value in zip(polygon.loop_indices, values):
            layer.data[index].uv = value
    result.update()
    obj.data = result
    print('LEAF_CARDS', obj.name, cards, 'of', len(components), 'triangles', triangle_count(result))

# Reduce the *prototype* leaves and twigs before the author's geometry nodes instance them.
# This retains their branching/scatter construction, not just a sparse subset of whole leaves.
for obj in list(bpy.data.objects):
    if obj.type != 'MESH':
        continue
    if '_leaves_' in obj.name and '_LOD' in obj.name:
        leaf_cards(obj)
    elif '_branches_' in obj.name and '_LOD' in obj.name:
        reduce_mesh(obj, 48)

tree = bpy.data.objects[asset_id + '_geometry_nodes']
in_scene(tree)
for modifier in tree.modifiers:
    if modifier.type != 'NODES':
        continue
    # Keep generation seeds/branch probability, reduce tube subdivisions only.
    # Source point counts also drive leaf placement; do not reduce branch/twig
    # resampling here. Reduce the realised woody surfaces below instead.
    resolutions = {}
    for socket in modifier.node_group.interface.items_tree:
        if socket.item_type == 'SOCKET' and socket.in_out == 'INPUT' and socket.name in resolutions:
            modifier[socket.identifier] = resolutions[socket.name]
    group = modifier.node_group.copy()
    modifier.node_group = group
    for node in list(group.nodes):
        if node.type == 'GROUP_OUTPUT' and node.is_active_output:
            original = node.inputs['Geometry'].links[0].from_socket
            realise = group.nodes.new('GeometryNodeRealizeInstances')
            group.links.new(original, realise.inputs['Geometry'])
            group.links.new(realise.outputs['Geometry'], node.inputs['Geometry'])

bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = tree.evaluated_get(depsgraph)
mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
# The author's procedural version is translated beside the baked LODs for editing.
# Its mesh is already in tree-local coordinates; that display offset is not part of
# the asset and must not separate the crown from the scanned trunk at the origin.
result = bpy.data.objects.new('VANA natural broadleaf', mesh)
bpy.context.scene.collection.objects.link(result)
selected = [result]
if asset_id == 'tree_small_02':
    trunk = bpy.data.objects[asset_id + '_trunk'].copy()
    trunk.data = trunk.data.copy()
    trunk.modifiers.clear()
    bpy.context.scene.collection.objects.link(trunk)
    selected.append(trunk)

# Explicitly export only the derivative, never the author's alternative LODs/prototypes.
for obj in bpy.context.view_layer.objects:
    obj.select_set(False)
for obj in selected:
    in_scene(obj)
    obj.select_set(True)
bpy.context.view_layer.objects.active = result
if len(selected) > 1:
    bpy.ops.object.join()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Separate material surfaces before budgeted simplification: bark must not consume the leaf
# budget, or dense foliage must not erase the main trunk.
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='MATERIAL')
bpy.ops.object.mode_set(mode='OBJECT')
parts = list(bpy.context.selected_objects)
counts = []
for part in parts:
    material = part.data.materials[0]
    leaf = 'leaves' in material.name
    branch = 'branch' in material.name
    # Never collapse the realised canopy globally: that deletes whole leaf clusters.
    # The reusable prototypes above own the foliage budget.
    if not leaf:
        reduce_mesh(part, 4000 if branch else 3000)
    for polygon in part.data.polygons:
        polygon.use_smooth = True
    counts.append({'material': material.name, 'triangles': triangle_count(part.data)})

# Convert the leaf shader group to a direct glTF-compatible PBR surface. Use the source
# texture images and UV coordinates; normal/roughness remain data maps. No image synthesis.
for material in {m for part in parts for m in part.data.materials}:
    if 'leaves' not in material.name:
        continue
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    textures = {n.image.filepath: n for n in nodes if n.type == 'TEX_IMAGE' and n.image}
    output_node = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
    shader = nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Roughness'].default_value = 0.85
    shader.inputs['Metallic'].default_value = 0
    links.new(shader.outputs['BSDF'], output_node.inputs['Surface'])
    for path, node in textures.items():
        if '_diff_' in path:
            # Blender 4.5's mixed-image exporter copies image.pixels straight into
            # a byte PNG when packing RGB + alpha. Read original sRGB code values
            # for that packing step, not linearised values (which darken twice in
            # a glTF viewer). glTF baseColorTexture is sRGB by specification.
            # Only this in-memory export scene changes; source PNGs stay untouched.
            node.image.colorspace_settings.name = 'Non-Color'
            links.new(node.outputs['Color'], shader.inputs['Base Color'])
        elif '_alpha_' in path:
            node.image.colorspace_settings.name = 'Non-Color'
            links.new(node.outputs['Color'], shader.inputs['Alpha'])
        elif '_rough_' in path:
            links.new(node.outputs['Color'], shader.inputs['Roughness'])
        elif '_nor_gl_' in path:
            normal = nodes.new('ShaderNodeNormalMap')
            links.new(node.outputs['Color'], normal.inputs['Color'])
            links.new(normal.outputs['Normal'], shader.inputs['Normal'])
    material.surface_render_method = 'DITHERED'
    material.use_backface_culling = False

vertices = [part.matrix_world @ v.co for part in parts for v in part.data.vertices]
low = min(v.z for v in vertices)
high = max(v.z for v in vertices)
base = [v for v in vertices if v.z < low + (high - low) * 0.015]
anchor = Vector((sum(v.x for v in base) / len(base), sum(v.y for v in base) / len(base), low))
scale = 8.0 / (high - low)
for part in parts:
    for vertex in part.data.vertices:
        vertex.co = (part.matrix_world @ vertex.co - anchor) * scale
    part.matrix_world.identity()
    part.select_set(True)

output_path = Path(output).resolve()
output_path.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output_path), export_format='GLB', use_selection=True,
    export_animations=False, export_cameras=False, export_lights=False, export_yup=True,
    # Blender keeps alpha-bearing leaf albedo as PNG even in JPEG mode.
    export_image_format='JPEG', export_extras=False)

# Exporter may choose BLEND for a connected alpha socket. These leaves intentionally use
# cutout depth/shadow rendering in the instanced forest; encode that contract in the GLB.
binary = output_path.read_bytes()
length = struct.unpack_from('<I', binary, 12)[0]
gltf = json.loads(binary[20:20 + length])
for material in gltf['materials']:
    if 'leaves' in material['name']:
        material['alphaMode'] = 'MASK'
        material['alphaCutoff'] = 0.5
        material['doubleSided'] = True
gltf['asset']['copyright'] = 'Poly Haven CC0; Rob Tuytel / Rico Cilliers. Local VANA reduced derivative; generic broadleaf visual.'
gltf['asset']['extras'] = {'source': f'https://polyhaven.com/a/{asset_id}', 'heightM': 8,
    'conversion': 'Blender 4.5.9; per-leaf UV cutout cards, realised source geometry nodes, reduced bark, sRGB alpha packing',
    'speciesAccurate': False}
encoded = json.dumps(gltf, separators=(',', ':')).encode('utf8')
encoded += b' ' * ((-len(encoded)) % 4)
tail = binary[20 + length:]
output_path.write_bytes(struct.pack('<4sII', b'glTF', 2, 20 + len(encoded) + len(tail))
    + struct.pack('<I4s', len(encoded), b'JSON') + encoded + tail)
print('VANA_TREE_EXPORT', json.dumps({'asset': asset_id, 'surfaces': counts,
    'heightM': 8, 'output': str(output_path), 'bytes': output_path.stat().st_size}))
