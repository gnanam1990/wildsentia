"""Shrink the hare's embedded textures; geometry, skin and animation bytes are untouched.

The shipped Rabbit.glb carried three 1024x1024 PNGs (3.7 MB) for an animal 22 cm tall that
fills a few dozen pixels on screen. This rewrites only the image buffer views:

- Fur (alpha-masked cards): 512x512 PNG, alpha kept
- rabbit-NORM (normal map): 512x512 PNG
- rabbit-skinn (opaque body; its alpha channel is unused): 512x512 JPEG, quality 90

Usage: python3 tools/assets/shrink_rabbit_textures.py INPUT.glb OUTPUT.glb
Deterministic for the same input and Pillow version.
"""
import hashlib, io, json, struct, sys
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
json_len = struct.unpack_from('<I', data, 12)[0]
doc = json.loads(data[20:20 + json_len])
bin_start = 28 + json_len
binary = data[bin_start:bin_start + doc['buffers'][0]['byteLength']]

def view_bytes(index):
    v = doc['bufferViews'][index]
    return binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]

replaced = {}
for image in doc['images']:
    original = Image.open(io.BytesIO(view_bytes(image['bufferView'])))
    small = original.resize((512, 512), Image.LANCZOS)
    buf = io.BytesIO()
    if image['name'] == 'rabbit-skinn':
        small.convert('RGB').save(buf, 'JPEG', quality=90, optimize=True)
        image['mimeType'] = 'image/jpeg'
    else:
        small.save(buf, 'PNG', optimize=True)
    replaced[image['bufferView']] = buf.getvalue()

# Re-pack every buffer view in its original order, 4-byte aligned.
packed = bytearray()
order = sorted(range(len(doc['bufferViews'])), key=lambda i: doc['bufferViews'][i].get('byteOffset', 0))
for i in order:
    chunk = replaced.get(i, view_bytes(i))
    while len(packed) % 4: packed.append(0)
    doc['bufferViews'][i]['byteOffset'] = len(packed)
    doc['bufferViews'][i]['byteLength'] = len(chunk)
    packed += chunk
while len(packed) % 4: packed.append(0)
doc['buffers'][0]['byteLength'] = len(packed)
doc['asset'].setdefault('extras', {})['textureBudget'] = {
    'sourceSha256': hashlib.sha256(data).hexdigest(),
    'tool': 'tools/assets/shrink_rabbit_textures.py',
    'textures': '512x512; Fur and normal map PNG, opaque body JPEG q90',
}

json_bytes = json.dumps(doc, separators=(',', ':')).encode()
json_bytes += b' ' * ((4 - len(json_bytes) % 4) % 4)
total = 12 + 8 + len(json_bytes) + 8 + len(packed)
with open(out, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(json_bytes), 0x4E4F534A)); f.write(json_bytes)
    f.write(struct.pack('<II', len(packed), 0x004E4942)); f.write(packed)
print(f'{src}: {len(data)} -> {total} bytes')
