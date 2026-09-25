/** Reproducible CC0 assembly. Reads pinned ZIP data only; runs no downloaded code.
 * node tools/assets/build_humans.mjs NEW_OUTPUT_DIRECTORY
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { Matrix4, Matrix3, Vector3, Quaternion } from 'three';
import { NodeIO } from '@gltf-transform/core';
import { copyToDocument, prune, dedup, unpartition, textureCompress, resample } from '@gltf-transform/functions';
import sharp from 'sharp';

const output = process.argv[2];
if (!output) throw new Error('New output directory required');
const io = new NodeIO();
const hash = b => createHash('sha256').update(b).digest('hex');
const pins = {
  'humans-base': 'fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40',
  'humans-outfits': 'c3468b18871cc8c8f05ab14df7712baf22cb9f389cbd870babf130e595187f70',
  'humans-motion': 'cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724',
};
const packs = {};
for (const [name, digest] of Object.entries(pins)) {
  const bytes = readFileSync(`tools/assets/sources/${name}/standard.zip`);
  if (hash(bytes) !== digest) throw new Error(`Source changed: ${name}`);
  packs[name] = unzipSync(bytes, { filter: f => {
    if (f.name.startsWith('/') || f.name.split('/').includes('..') || f.originalSize > 100_000_000) throw new Error('Unsafe archive entry');
    return /\.(gltf|bin|glb|png|txt)$/.test(f.name) && !f.name.includes('Textures/') && !f.name.includes('Modular Parts/');
  } });
}
async function model(pack, suffix) {
  const files = packs[pack], matches = Object.keys(files).filter(n => n.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Ambiguous/missing ${suffix}`);
  const name = matches[0];
  if (name.endsWith('.glb')) return io.readBinary(files[name]);
  const json = JSON.parse(strFromU8(files[name])), resources = {};
  for (const item of [...json.buffers, ...(json.images ?? [])]) {
    if (!item.uri || item.uri.includes('/') || item.uri.includes('..')) throw new Error('Unexpected external reference');
    let uri = item.uri;
    // Publisher's GLTF refers to this alternate spelling; the ZIP supplies T_Eye_Normal.png.
    if (['T_Eye_Normal_png.png', 'T_Hair_1_Normal_png.png', 'T_Hair_2_Normal_png.png'].includes(uri)) uri = uri.replace('_png.png', '.png');
    const data = files[posix.join(posix.dirname(name), uri)];
    if (!data) throw new Error(`Missing source ${uri}`);
    resources[item.uri] = data;
  }
  return io.readJSON({ json, resources });
}
function named(doc, name) {
  const nodes = doc.getRoot().listNodes().filter(n => n.getName() === name);
  if (nodes.length !== 1) throw new Error(`Expected exactly one ${name}`);
  return nodes[0];
}
function appendHead(target, source, headOnly) {
  const skin = target.getRoot().listSkins()[0], head = named(target, 'Head');
  const headJoint = skin.listJoints().indexOf(head);
  if (headJoint < 0) throw new Error('Missing head joint');
  const sourceHead = new Matrix4().fromArray(named(source, 'Head').getWorldMatrix());
  const targetHead = new Matrix4().fromArray(head.getWorldMatrix());
  const cutY = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(named(source, 'neck_01').getWorldMatrix())).y - .055;
  const headOrigin = new Vector3().setFromMatrixPosition(sourceHead);
  for (const original of source.getRoot().listNodes().filter(n => n.getMesh())) {
    const world = new Matrix4().fromArray(original.getWorldMatrix());
    const transform = targetHead.clone().multiply(sourceHead.clone().invert()).multiply(world);
    const normalTransform = new Matrix3().getNormalMatrix(transform);
    const copied = copyToDocument(target, source, [original.getMesh()]).get(original.getMesh());
    for (const p of copied.listPrimitives()) {
      const pos = p.getAttribute('POSITION'), normals = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0');
      const raw = pos.getArray(), originalIndex = p.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.getCount() }, (_, i) => i);
      const retained = [];
      for (let i = 0; i < originalIndex.length; i += 3) {
        const tri = Array.from(originalIndex.slice(i, i + 3));
        if (!headOnly || tri.every(v => {
          const point = new Vector3().fromArray(raw, v * 3).applyMatrix4(world);
          return point.y >= cutY && (point.y >= headOrigin.y + .025 || Math.abs(point.x - headOrigin.x) < .105);
        })) retained.push(...tri);
      }
      if (!retained.length) { copied.removePrimitive(p); continue; }
      const unique = [...new Set(retained)], remap = new Map(unique.map((v, i) => [v, i]));
      const vertices = [], ns = [], uvs = [], joints = [], weights = [];
      for (const i of unique) {
        vertices.push(...new Vector3().fromArray(raw, i * 3).applyMatrix4(transform).toArray());
        ns.push(...new Vector3().fromArray(normals.getArray(), i * 3).applyMatrix3(normalTransform).normalize().toArray());
        uvs.push(...uv.getArray().slice(i * 2, i * 2 + 2));
        joints.push(headJoint, 0, 0, 0); weights.push(1, 0, 0, 0);
      }
      const attribute = (type, array) => target.createAccessor().setBuffer(target.getRoot().listBuffers()[0]).setType(type).setArray(array);
      for (const key of p.listSemantics()) p.setAttribute(key, null);
      p.setAttribute('POSITION', attribute('VEC3', new Float32Array(vertices)));
      p.setAttribute('NORMAL', attribute('VEC3', new Float32Array(ns)));
      p.setAttribute('TEXCOORD_0', attribute('VEC2', new Float32Array(uvs)));
      p.setAttribute('JOINTS_0', attribute('VEC4', new Uint16Array(joints)));
      p.setAttribute('WEIGHTS_0', attribute('VEC4', new Float32Array(weights)));
      p.setIndices(attribute('SCALAR', Uint32Array.from(retained, v => remap.get(v))));
    }
    if (copied.listPrimitives().length) target.getRoot().listScenes()[0].addChild(target.createNode(`assembled_${original.getName()}`).setMesh(copied).setSkin(skin));
  }
}
const motions = await model('humans-motion', '/Unreal-Godot/UAL1_Standard.glb');
const clips = ['Idle_Loop', 'Walk_Loop', 'Fixing_Kneeling', 'PickUp_Table', 'Interact', 'Crouch_Idle_Loop', 'Death01'];
function addMotion(target) {
  const buffer = target.getRoot().listBuffers()[0];
  for (const name of clips) {
    const source = motions.getRoot().listAnimations().find(a => a.getName() === name);
    if (!source) throw new Error(`Missing motion ${name}`);
    const animation = target.createAnimation(name);
    for (const channel of source.listChannels()) {
      const from = channel.getTargetNode(), to = named(target, from.getName()), path = channel.getTargetPath();
      // Preserve target limb lengths and disable scene root motion. Pelvis vertical bob only.
      if (path !== 'rotation' && !(path === 'translation' && from.getName() === 'pelvis')) continue;
      const sampler = channel.getSampler();
      if (sampler.getInterpolation() === 'CUBICSPLINE') throw new Error('Unsupported cubic animation');
      const values = new Float32Array(sampler.getOutput().getArray());
      if (path === 'rotation') {
        const offset = new Quaternion().fromArray(to.getRotation()).multiply(new Quaternion().fromArray(from.getRotation()).invert());
        for (let i = 0; i < values.length; i += 4) new Quaternion().copy(offset).multiply(new Quaternion().fromArray(values, i)).normalize().toArray(values, i);
      } else {
        const a = from.getTranslation(), b = to.getTranslation();
        const sourceParent = new Matrix3().setFromMatrix4(new Matrix4().fromArray(from.getParentNode().getWorldMatrix()));
        const targetParentInverse = new Matrix3().setFromMatrix4(new Matrix4().fromArray(to.getParentNode().getWorldMatrix())).invert();
        const ratio = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(to.getWorldMatrix())).y
          / new Vector3().setFromMatrixPosition(new Matrix4().fromArray(from.getWorldMatrix())).y;
        for (let i = 0; i < values.length; i += 3) {
          const delta = new Vector3(values[i] - a[0], values[i + 1] - a[1], values[i + 2] - a[2]).applyMatrix3(sourceParent);
          delta.set(0, delta.y * ratio, 0).applyMatrix3(targetParentInverse).add(new Vector3().fromArray(b)).toArray(values, i);
        }
      }
      const input = target.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Float32Array(sampler.getInput().getArray()));
      const out = target.createAccessor().setBuffer(buffer).setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(values);
      const s = target.createAnimationSampler().setInput(input).setOutput(out).setInterpolation(sampler.getInterpolation());
      animation.addSampler(s).addChannel(target.createAnimationChannel().setTargetNode(to).setTargetPath(path).setSampler(s));
    }
  }
}
mkdirSync(output); // Fail rather than overwrite an existing build.
const report = { sources: pins, method: 'CC0 peasant clothing, cropped base heads, head-bound hair, rest-relative in-place retarget', clips, files: [] };
for (const sex of ['Female', 'Male']) {
  const outfit = await model('humans-outfits', `/Outfits/${sex}_Peasant.gltf`);
  const base = await model('humans-base', `/Godot - UE/Superhero_${sex}_FullBody.gltf`);
  appendHead(outfit, base, true);
  const hairstyle = sex === 'Female' ? 'Hair_Buns' : 'Hair_Buzzed';
  const hair = await model('humans-base', `/Rigged to Head Bone/glTF (Godot -Unreal)/${hairstyle}.gltf`);
  appendHead(outfit, hair, false);
  addMotion(outfit);
  await outfit.transform(resample({ tolerance: .0001 }), prune(), dedup(), unpartition(),
    textureCompress({ encoder: sharp, resize: [512, 512] }),
    textureCompress({ encoder: sharp, pattern: /^T_(Peasant|Superhero|Regular|Eye)/, targetFormat: 'jpeg', quality: 88 }));
  const bytes = await io.writeBinary(outfit), filename = `human-${sex.toLowerCase()}.glb`;
  writeFileSync(resolve(output, filename), bytes, { flag: 'wx' });
  report.files.push({ filename, bytes: bytes.length, sha256: hash(bytes), triangles: outfit.getRoot().listMeshes().reduce((sum, m) => sum + m.listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0), 0) });
}
for (const [pack, files] of Object.entries(packs)) {
  const license = Object.entries(files).find(([n]) => /\/License[^/]*\.txt$/.test(n));
  if (!license || !strFromU8(license[1]).includes('CC0 1.0')) throw new Error('CC0 license missing');
  writeFileSync(resolve(output, `${pack}-LICENSE.txt`), license[1], { flag: 'wx' });
}
writeFileSync(resolve(output, 'build.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
