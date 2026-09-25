import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

for (const pack of ['humans-base', 'humans-outfits', 'humans-motion']) {
  const files = unzipSync(readFileSync(`tools/assets/sources/${pack}/standard.zip`), {
    filter: f => /License|README|Readme|Female_Peasant.gltf|Male_Peasant.gltf|UAL1_Standard.glb|Superhero_Female_FullBody.gltf/.test(f.name),
  });
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.txt')) { console.log(name, strFromU8(bytes)); continue; }
    const b = Buffer.from(bytes);
    const j = JSON.parse(name.endsWith('.glb') ? b.subarray(20, 20 + b.readUInt32LE(12)).toString() : strFromU8(bytes));
    console.log(name, JSON.stringify({
      nodes: j.nodes.map((n, i) => ({ i, name: n.name, mesh: n.mesh, skin: n.skin, translation: n.translation, scale: n.scale })).filter(n => n.mesh !== undefined || n.i < 8),
      meshes: j.meshes?.map(m => ({ name: m.name, parts: m.primitives.length })),
      animations: j.animations?.map(a => a.name), images: j.images,
      materials: j.materials?.map(m => m.name), skins: j.skins?.map(s => ({ joints: s.joints.length, skeleton: s.skeleton })),
    }));
  }
}
