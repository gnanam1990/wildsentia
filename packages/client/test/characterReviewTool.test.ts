import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tool = fileURLToPath(new URL('../../../tools/assets/bake_character_review.mjs', import.meta.url));
const source = fileURLToPath(new URL('../public/assets/animals/TigerRigged.glb', import.meta.url));
const run = (out: string, clip = 'Walk', time = '0') => spawnSync(process.execPath,
  [tool, source, out, 'TigerRiggedMesh', clip, time], { encoding: 'utf8' });
const manifest = (bytes: Buffer) => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());

describe('character art review tools', () => {
  it('bakes differing Three.js poses with finite geometry without changing the source or overwriting output', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'vana-pose-test-'));
    try {
      const before = readFileSync(source);
      const first = join(scratch, 'first.glb'); const second = join(scratch, 'second.glb');
      const firstRun = run(first); const secondRun = run(second, 'Walk', '0.5');
      expect(firstRun.status, firstRun.stderr).toBe(0);
      expect(secondRun.status, secondRun.stderr).toBe(0);
      const a = readFileSync(first); const b = readFileSync(second);
      const j = manifest(a); const k = manifest(b);
      expect(a.readUInt32LE(8)).toBe(a.length);
      expect(j.asset.extras.reviewOnly).toBe(true);
      expect(j.animations).toBeUndefined(); expect(j.skins).toBeUndefined();
      expect(j.nodes).toEqual([{ mesh: 0 }]);
      expect(j.images).toEqual(manifest(before).images);
      expect(j.materials).toEqual(manifest(before).materials);
      const attribute = j.meshes[0].primitives[0].attributes;
      expect(attribute.JOINTS_0).toBeUndefined(); expect(attribute.WEIGHTS_0).toBeUndefined();
      const positions = (bytes: Buffer, json: typeof j) => {
        const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
        const view = json.bufferViews[accessor.bufferView];
        const start = 28 + bytes.readUInt32LE(12) + view.byteOffset;
        return Array.from({ length: accessor.count * 3 }, (_, i) => bytes.readFloatLE(start + i * 4));
      };
      const p = positions(a, j); const q = positions(b, k);
      expect(p.every(Number.isFinite)).toBe(true);
      expect(p.some((v, i) => Math.abs(v - q[i]!) > 1e-5)).toBe(true);
      expect(run(first).status).not.toBe(0);
      expect(readFileSync(first)).toEqual(a);
      expect(readFileSync(source)).toEqual(before);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 15000);
  it('rejects a nonexistent clip and invalid time instead of silently rendering another pose', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'vana-pose-test-'));
    try {
      expect(run(join(scratch, 'bad.glb'), 'NoSuchClip').status).not.toBe(0);
      expect(run(join(scratch, 'bad.glb'), 'Walk', 'NaN').status).not.toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
