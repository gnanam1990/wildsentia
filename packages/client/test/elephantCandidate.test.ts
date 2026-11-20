import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { visualFor, modelStatus } from '../src/species.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'tools/assets/sources/elephant/asian-elephant-original.glb');
const tool = (name: string, ...args: string[]) => spawnSync(process.execPath,
  [join(root, 'tools/assets', name), ...args], { encoding: 'utf8' });
const documents = new WeakMap<Buffer, ReturnType<typeof JSON.parse>>();
const document = (bytes: Buffer) => {
  if (!documents.has(bytes)) documents.set(bytes, JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()));
  return documents.get(bytes)!;
};
// Compare exact bytes without a multi-megabyte object-diff walk on passing assertions.
const sameBytes = (a: Buffer, b: Buffer) => expect(a.equals(b)).toBe(true);
// Independent accessor extraction including byteStride; compare actual bytes, not only metadata.
const accessor = (bytes: Buffer, index: number) => {
  const doc = document(bytes), a = doc.accessors[index], view = doc.bufferViews[a.bufferView];
  const size = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[a.type]!
    * ({ 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType]!;
  return Buffer.concat(Array.from({ length: a.count }, (_, i) => {
    const start = 28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (view.byteStride ?? size);
    return bytes.subarray(start, start + size);
  }));
};
const image = (bytes: Buffer) => {
  const doc = document(bytes), view = doc.bufferViews[doc.images[0].bufferView];
  const start = 28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0);
  return bytes.subarray(start, start + view.byteLength);
};

describe('licensed elephant candidate preparation', () => {
  it('keeps the anatomically richer but incomplete review rig out of the live observer', () => {
    const compact = readFileSync(join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantCompact.glb'));
    const loop = readFileSync(join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantLoopReview.glb'));
    const live = readFileSync(join(root, 'packages/client/public/assets/animals/ElephantWalking.glb'));
    expect(document(compact).asset.extras.vanaReviewOnly).toBe(true);
    expect(document(loop).asset.extras.vanaReviewOnly).toBe(true);
    const clipNames = (bytes: Buffer): string[] => document(bytes).animations.map((clip: { name: string }) => clip.name);
    expect(clipNames(loop)).toEqual(['Idle', 'Walk', 'SprayWater 1', 'SprayWater']);
    expect(clipNames(loop)).not.toContain('Eating');
    expect(clipNames(live)).toContain('Eating');
    expect(visualFor('elephant').model?.file).toBe('/assets/animals/ElephantWalking.glb');
    expect(modelStatus('elephant')).toContain('Generic elephant rig');
  });

  it('authors only the Walk tail, closes the pose seam and reduces sampled velocity mismatch without live promotion', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-loop-test-'));
    try {
      const compact = join(root, 'tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantCompact.glb');
      const before = readFileSync(compact), beforeDoc = document(before), output = join(scratch, 'loop.glb');
      const close = tool('close_elephant_walk.mjs', compact, output);
      expect(close.status, close.stderr).toBe(0);
      const after = readFileSync(output), afterDoc = document(after);
      expect(afterDoc.asset.extras.vanaReviewOnly).toBe(true);
      expect(afterDoc.asset.extras.walkLoopReview.correctionStart).toBeCloseTo(5.7333331, 6);
      const binary = (bytes: Buffer) => bytes.subarray(28 + bytes.readUInt32LE(12), 28 + bytes.readUInt32LE(12) + document(bytes).buffers[0].byteLength);
      sameBytes(binary(after).subarray(0, binary(before).length), binary(before));
      expect(afterDoc.animations.filter((a: { name: string }) => a.name !== 'Walk'))
        .toEqual(beforeDoc.animations.filter((a: { name: string }) => a.name !== 'Walk'));
      expect(afterDoc.nodes).toEqual(beforeDoc.nodes); expect(afterDoc.skins).toEqual(beforeDoc.skins);
      const oldWalk = beforeDoc.animations.find((a: { name: string }) => a.name === 'Walk');
      const newWalk = afterDoc.animations.find((a: { name: string }) => a.name === 'Walk');
      for (let i = 0; i < oldWalk.samplers.length; i++) {
        const oldSampler = oldWalk.samplers[i], newSampler = newWalk.samplers[i];
        const oldTimes = accessor(before, oldSampler.input), newTimes = accessor(after, newSampler.input);
        let count = 0;
        while (count * 4 < oldTimes.length && oldTimes.readFloatLE(count * 4) < afterDoc.asset.extras.walkLoopReview.correctionStart) count++;
        sameBytes(newTimes.subarray(0, count * 4), oldTimes.subarray(0, count * 4));
        const width = beforeDoc.accessors[oldSampler.output].type === 'VEC4' ? 16 : 12;
        sameBytes(accessor(after, newSampler.output).subarray(0, count * width), accessor(before, oldSampler.output).subarray(0, count * width));
      }
      const audit = tool('audit_character_motion.mjs', compact, output, 'Object_7', '12', 'walk-loop');
      expect(audit.status, audit.stderr).toBe(0);
      const checked = JSON.parse(audit.stdout);
      expect(checked.exactPoseAgreement).toBe(false); // An intentional authored derivative, not lossless pruning.
      expect(checked.maximumOutsideTailDifference).toBeLessThan(1e-9);
      expect(checked.maximumAuthoredDifferenceInBodyHeights).toBeLessThan(.05);
      const walk = checked.results.find((clip: { clip: string }) => clip.clip === 'Walk');
      expect(walk.loopEndpointGap.maximum).toBe(0); expect(walk.changedVertexSamples).toBeGreaterThan(300_000);
      const analysis = (file: string) => {
        const result = tool('analyze_character_loop.mjs', file, 'Object_7', 'Walk', '30');
        expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
      };
      const oldLoop = analysis(compact), newLoop = analysis(output);
      expect(newLoop.clipDuration).toBe(oldLoop.clipDuration);
      expect(oldLoop.endpoint.maxGapInBodyHeights).toBeGreaterThan(.018);
      expect(newLoop.endpoint.maxGapInBodyHeights).toBe(0);
      expect(newLoop.endpoint.rmsVelocityGapInBodyHeightsPerSecond).toBeLessThan(oldLoop.endpoint.rmsVelocityGapInBodyHeightsPerSecond * .1);
      expect(tool('close_elephant_walk.mjs', compact, output).status).not.toBe(0);
      sameBytes(readFileSync(output), after); sameBytes(readFileSync(compact), before);
      expect(tool('close_elephant_walk.mjs', source, join(scratch, 'wrong.glb')).status).not.toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 15000);

  it('isolates/prunes reproducibly without altering geometry, weighted binds, keyframes, texture or source', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'vana-elephant-test-'));
    try {
      const original = readFileSync(source), originalDoc = document(original);
      const isolated = join(scratch, 'isolated.glb'), compact = join(scratch, 'compact.glb');
      const isolate = tool('isolate_elephant_candidate.mjs', source, isolated);
      expect(isolate.status, isolate.stderr).toBe(0);
      const prune = tool('prune_elephant_candidate.mjs', isolated, compact);
      expect(prune.status, prune.stderr).toBe(0);
      const bytes = readFileSync(compact), doc = document(bytes);
      expect(bytes.readUInt32LE(8)).toBe(bytes.length); expect(bytes.length).toBeLessThan(original.length * .52);
      expect(doc.nodes).toHaveLength(105); expect(doc.meshes).toHaveLength(1);
      expect(doc.skins[0].joints).toHaveLength(64); expect(doc.images).toHaveLength(1);
      expect(doc.asset.extras.vanaReviewOnly).toBe(true);
      for (const key of ['author', 'license', 'source', 'title']) expect(doc.asset.extras[key]).toEqual(originalDoc.asset.extras[key]);
      const a = originalDoc.meshes[0].primitives[0], b = doc.meshes[0].primitives[0];
      for (const key of Object.keys(a.attributes).filter((k) => k !== 'JOINTS_0')) {
        sameBytes(accessor(bytes, b.attributes[key]), accessor(original, a.attributes[key]));
      }
      sameBytes(accessor(bytes, b.indices), accessor(original, a.indices));
      sameBytes(image(bytes), image(original)); expect(doc.materials).toEqual([originalDoc.materials[0]]);
      const oldJoints = accessor(original, a.attributes.JOINTS_0), newJoints = accessor(bytes, b.attributes.JOINTS_0);
      const weights = accessor(original, a.attributes.WEIGHTS_0);
      const oldBind = accessor(original, originalDoc.skins[0].inverseBindMatrices), newBind = accessor(bytes, doc.skins[0].inverseBindMatrices);
      for (let i = 0; i < oldJoints.length / 2; i++) if (weights.readFloatLE(i * 4) > 0) {
        const oldIndex = oldJoints.readUInt16LE(i * 2), newIndex = newJoints.readUInt16LE(i * 2);
        expect(doc.nodes[doc.skins[0].joints[newIndex]].name).toBe(originalDoc.nodes[originalDoc.skins[0].joints[oldIndex]].name);
        sameBytes(newBind.subarray(newIndex * 64, (newIndex + 1) * 64), oldBind.subarray(oldIndex * 64, (oldIndex + 1) * 64));
      }
      for (let clip = 0; clip < originalDoc.animations.length; clip++) {
        const before = originalDoc.animations[clip], after = doc.animations[clip];
        expect(after.name).toBe(before.name); expect(after.channels).toHaveLength(before.channels.length);
        for (let index = 0; index < before.channels.length; index++) {
          const oldChannel = before.channels[index], newChannel = after.channels[index];
          expect(doc.nodes[newChannel.target.node].name).toBe(originalDoc.nodes[oldChannel.target.node].name);
          expect(newChannel.target.path).toBe(oldChannel.target.path);
          const oldSampler = before.samplers[oldChannel.sampler], newSampler = after.samplers[newChannel.sampler];
          expect(newSampler.interpolation).toBe(oldSampler.interpolation);
          sameBytes(accessor(bytes, newSampler.input), accessor(original, oldSampler.input));
          sameBytes(accessor(bytes, newSampler.output), accessor(original, oldSampler.output));
        }
      }
      const audit = tool('audit_character_motion.mjs', source, compact, 'Object_7', '3', 'pruned');
      expect(audit.status, audit.stderr).toBe(0);
      const evidence = JSON.parse(audit.stdout);
      expect(evidence.exactPoseAgreement).toBe(true); expect(evidence.visibleMeshes).toEqual(['Object_7']);
      expect(evidence.results).toHaveLength(4); expect(evidence.checkedVertices).toBeGreaterThan(200_000);
      // Walk endpoint mismatch is a real unresolved source-art issue, not erased by pruning.
      expect(evidence.results.find((clip: { clip: string }) => clip.clip === 'Walk').loopEndpointGap.maximum).toBeGreaterThan(0);
      expect(tool('prune_elephant_candidate.mjs', isolated, compact).status).not.toBe(0);
      sameBytes(readFileSync(compact), bytes); sameBytes(readFileSync(source), original);
      expect(tool('prune_elephant_candidate.mjs', source, join(scratch, 'unreviewed.glb')).status).not.toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 15000);
});
