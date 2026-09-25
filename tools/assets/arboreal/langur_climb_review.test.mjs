import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = path.join(root, 'packages/client/public/assets/animals/Langur.glb');
const candidate = path.join(root, 'docs/art-review/langur-2026-09-25/LangurClimbReview.glb');
const tool = path.join(root, 'tools/assets/arboreal/author_langur_climb_review.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function glb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  const binStart = 28 + jsonLength;
  const bin = bytes.subarray(binStart, binStart + bytes.readUInt32LE(binStart - 8));
  return { json, bin };
}

test('review-only Langur climb clip appends without rewriting source skin, materials or clips', () => {
  const sourceBytes = readFileSync(source), outputBytes = readFileSync(candidate);
  const a = glb(sourceBytes), b = glb(outputBytes);
  assert.equal(sha(sourceBytes), 'baed053b237edf9dbf08b408b8319efac9e3bd2f290e27ea3677208532c69c2b');
  assert.deepEqual(b.bin.subarray(0, a.json.buffers[0].byteLength), a.bin.subarray(0, a.json.buffers[0].byteLength));
  for (const key of ['nodes', 'meshes', 'skins', 'materials', 'textures', 'images'])
    assert.deepEqual(b.json[key], a.json[key], key);
  assert.deepEqual(b.json.animations.slice(0, 8), a.json.animations);
  assert.equal(b.json.animations[8].name, 'ClimbReview');
  assert.equal(b.json.animations[8].channels.length, 63);
  assert.equal(b.json.asset.extras.vanaReviewOnly, true);
  assert.equal(b.json.asset.extras.climbReview.sourceSha256, sha(sourceBytes));
  // The experiment is stored outside the live /assets/animals route.
  assert.equal(candidate.includes('/docs/art-review/'), true);
});

test('Langur climb candidate regenerates byte-for-byte and cannot drift upward per frame', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vana-langur-review-'));
  try {
    const generated = path.join(directory, 'candidate.glb');
    const command = spawnSync(process.execPath, [tool, source, generated], {
      cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    assert.equal(command.status, 0, command.stderr);
    const report = JSON.parse(command.stdout);
    assert.equal(sha(readFileSync(generated)), sha(readFileSync(candidate)));
    assert.equal(report.contactSamples.length, 5);
    assert.deepEqual(report.contactSamples[0].footJoints, report.contactSamples.at(-1).footJoints);
    for (const frame of report.contactSamples) {
      assert(frame.head[1] > .9 && frame.head[1] < 1.2, 'no accumulated root climb inside animation');
      for (const foot of frame.footJoints) {
        const [x, y, z] = foot.position;
        assert(Number.isFinite(y));
        assert(Math.abs(Math.hypot(x, z) - .245) < .03, 'joint target remains near illustrative cylinder');
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
