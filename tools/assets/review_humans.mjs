/** CPU projection of actual skinned geometry, not browser/WebGL visual acceptance. */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import sharp from 'sharp';

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Expected asset directory and new review PNG');
globalThis.ProgressEvent ??= class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
const panels = [], audit = [];
const views = [['Idle_Loop', .3, 0], ['Walk_Loop', .3, .5], ['Fixing_Kneeling', .5, .5], ['Death01', 2.5, .2]];
for (const [row, sex] of ['female', 'male'].entries()) {
  const bytes = readFileSync(`${directory}/human-${sex}.glb`), len = bytes.readUInt32LE(12);
  const original = JSON.parse(bytes.subarray(20, 20 + len).toString());
  const binary = bytes.subarray(28 + len, 28 + len + original.buffers[0].byteLength);
  const textures = await Promise.all(original.textures.map(async t => {
    const image = original.images[t.source], bv = original.bufferViews[image.bufferView];
    return sharp(binary.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  }));
  const json = structuredClone(original); json.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
  delete json.images; delete json.textures; delete json.materials;
  for (const mesh of json.meshes) for (const p of mesh.primitives) delete p.material;
  const gltf = await new GLTFLoader().parseAsync(JSON.stringify(json), '');
  const mixer = new THREE.AnimationMixer(gltf.scene);
  for (const [col, [clipName, t, angle]] of views.entries()) {
    mixer.stopAllAction(); const clip = gltf.animations.find(a => a.name === clipName);
    if (!clip) throw new Error('Missing clip');
    const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(Math.min(t, clip.duration));
    gltf.scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(28, 400 / 470, .01, 100);
    camera.position.set(Math.sin(angle) * 5, 1.3, Math.cos(angle) * 5); camera.lookAt(0, .95, 0); camera.updateMatrixWorld(true);
    const triangles = [], bounds = new THREE.Box3(); let vertices = 0;
    gltf.scene.traverse(mesh => {
      if (!mesh.isSkinnedMesh) return;
      mesh.skeleton.update(); const g = mesh.geometry, point = new THREE.Vector3();
      const points = [], projected = [];
      for (let i = 0; i < g.attributes.position.count; i++) {
        mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
        if (!point.toArray().every(Number.isFinite)) throw new Error('Nonfinite pose');
        bounds.expandByPoint(point); points.push(point.clone()); projected.push(point.clone().project(camera)); vertices++;
      }
      const association = gltf.parser.associations.get(mesh);
      const primitive = original.meshes[association.meshes].primitives[association.primitives ?? 0];
      const material = original.materials[primitive.material], textureId = material.pbrMetallicRoughness?.baseColorTexture?.index;
      const texture = textureId === undefined ? null : textures[textureId];
      const indices = g.index.array, uv = g.attributes.uv;
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const normal = points[b].clone().sub(points[a]).cross(points[c].clone().sub(points[a])).normalize();
        if (!material.doubleSided && normal.dot(camera.position.clone().sub(points[a])) < 0) continue;
        const shade = .5 + .5 * Math.max(0, normal.dot(new THREE.Vector3(-.4, .7, 1).normalize()));
        let rgb = [170, 150, 115];
        if (texture) {
          const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
          const x = Math.min(texture.info.width - 1, Math.floor(((u % 1 + 1) % 1) * texture.info.width));
          const y = Math.min(texture.info.height - 1, Math.floor(((v % 1 + 1) % 1) * texture.info.height));
          const at = (y * texture.info.width + x) * 4;
          if (material.alphaMode === 'MASK' && texture.data[at + 3] / 255 < (material.alphaCutoff ?? .5)) continue;
          rgb = Array.from(texture.data.subarray(at, at + 3));
        }
        const coords = [a, b, c].map(n => `${((projected[n].x + 1) * 200).toFixed(2)},${((1 - projected[n].y) * 235 + 35).toFixed(2)}`).join(' ');
        triangles.push({ z: (projected[a].z + projected[b].z + projected[c].z) / 3,
          svg: `<polygon points="${coords}" fill="rgb(${rgb.map(v => Math.round(v * shade)).join(',')})"/>` });
      }
    });
    const size = bounds.getSize(new THREE.Vector3());
    if (size.length() > 5 || vertices < 1000) throw new Error(`Invalid anatomy bounds: ${JSON.stringify(bounds)}`);
    audit.push({ sex, clipName, t, bounds, vertices });
    triangles.sort((a, b) => b.z - a.z);
    panels.push(`<g transform="translate(${col * 400},${row * 530})"><rect width="400" height="530" fill="#e1e5df"/><text x="15" y="24" font-family="sans-serif" font-size="18">${sex} · ${clipName}</text>${triangles.map(p => p.svg).join('')}</g>`);
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1060">${panels.join('')}</svg>`;
writeFileSync(output, await sharp(Buffer.from(svg)).png().toBuffer(), { flag: 'wx' });
writeFileSync(output + '.json', JSON.stringify(audit, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, audit }));
