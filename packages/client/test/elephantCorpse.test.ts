import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { AnimalLayer } from '../src/animals.js';

async function localRig(file: string) {
  const bytes = readFileSync(new URL(`../public${file}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + doc.buffers[0].byteLength);
  doc.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
  delete doc.images; delete doc.textures; delete doc.materials;
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  globalThis.ProgressEvent ??= class { constructor(public type: string, init: object) { Object.assign(this, init); } } as typeof ProgressEvent;
  return new GLTFLoader().parseAsync(JSON.stringify(doc), '');
}

describe('shipped Asian elephant corpse placement', () => {
  it('rests adult and calf geometry on terrain at the saved location without a death clip', async () => {
    const files = {
      male: '/assets/animals/AsianElephantAdultMale.glb',
      female: '/assets/animals/AsianElephantAdultFemale.glb',
      calf: '/assets/animals/AsianElephantCalf.glb',
    } as const;
    const loaded = new Map<string, Awaited<ReturnType<typeof localRig>>>();
    const loader = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (file) => {
      const path = String(file);
      if (!loaded.has(path)) loaded.set(path, await localRig(path));
      return loaded.get(path)! as never;
    });
    try {
      for (const [variant, file] of Object.entries(files)) {
        const layer = new AnimalLayer(); layer.groundHeightAt = () => 6;
        const animal = { id: `elephant-${variant}`, speciesId: 'elephant', patchId: 0,
          sex: variant === 'male' ? 'male' as const : 'female' as const,
          lifeStage: variant === 'calf' ? 'juvenile' as const : 'adult' as const,
          position: { x: 20, z: 30, heading: 0 }, state: 'dead', currentGoal: 'none',
          drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } };
        const animals = new Map([[animal.id, animal]]);
        layer.sync(animals, 0, animal.id, { x: 20, z: 30 });
        await vi.waitFor(() => expect(layer.pendingModelCount).toBe(0), { timeout: 2000, interval: 2 });
        layer.sync(animals, 1, animal.id, { x: 20, z: 30 });
        expect(loader).toHaveBeenCalledWith(file);
        const rig = layer.root.getObjectByName(animal.id)!;
        const box = new Box3().setFromObject(rig.children[0]!);
        expect(box.min.y).toBeCloseTo(6, 2);
        expect(box.getCenter(new Vector3()).distanceTo(new Vector3(20, box.getCenter(new Vector3()).y, 30)))
          .toBeLessThan(3);
        layer.sync(new Map(), 2, null, { x: 20, z: 30 });
      }
    } finally { loader.mockRestore(); }
  }, 15_000);
});
