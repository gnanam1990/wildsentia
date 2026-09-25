import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function glb(name: string) {
  const bytes = readFileSync(new URL(`../public/assets/animals/${name}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  return { bytes, doc, binStart: 28 + jsonLength };
}

describe('interim Asian-elephant calf visual', () => {
  it('ships a distinct, finite skinned derivative with the retargeted trunk and source credit', () => {
    const adult = glb('AsianElephantAdultFemale.glb');
    const calf = glb('AsianElephantCalf.glb');
    expect(calf.bytes.subarray(0, 4).toString()).toBe('glTF');
    expect(calf.bytes.readUInt32LE(8)).toBe(calf.bytes.length);
    expect(calf.doc.asset.extras.vanaInterimLive).toBe(true);
    expect(calf.doc.asset.extras.vanaReviewOnly).toBe(false);
    expect(calf.doc.asset.extras.license).toBe(adult.doc.asset.extras.license);
    expect(calf.doc.asset.extras.calfVisual.sourceSha256)
      .toBe('7ef132c352411cf4e88fd740d5a588b93aaceb8c8bc4f2c392bb743ff02efc8a');
    expect(calf.doc.skins[0].joints).toEqual(adult.doc.skins[0].joints);
    expect(calf.doc.animations.map((clip: { name: string }) => clip.name))
      .toEqual(adult.doc.animations.map((clip: { name: string }) => clip.name));
    for (let node = 87; node <= 100; node++) for (let axis = 0; axis < 3; axis++)
      expect(calf.doc.nodes[node].translation[axis]).toBeCloseTo(adult.doc.nodes[node].translation[axis] * 0.72, 6);
    const accessor = calf.doc.accessors[calf.doc.meshes[0].primitives[0].attributes.POSITION];
    const start = calf.binStart + calf.doc.bufferViews[accessor.bufferView].byteOffset;
    expect(accessor.count).toBe(4768);
    for (let i = 0; i < accessor.count * 3; i++)
      expect(Number.isFinite(calf.bytes.readFloatLE(start + i * 4))).toBe(true);
  });
});
