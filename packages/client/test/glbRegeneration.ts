import { expect } from 'vitest';

/**
 * Checks that an authoring tool regenerated a committed GLB. The header, JSON and every
 * non-float byte must match exactly. Float data computed with trigonometry may differ in its
 * last bits between CPU architectures: the committed arm64 output and a Linux x86_64 rerun
 * disagreed in 344 near-zero quaternion words by at most 2.2e-7. So only bytes inside FLOAT
 * accessors may differ, and only by a float32 rounding error.
 */
export function expectRegeneratedGlb(actual: Buffer, expected: Buffer): void {
  if (actual.equals(expected)) return;
  expect(actual.length).toBe(expected.length);
  const jsonLength = expected.readUInt32LE(12);
  const binStart = 28 + jsonLength;
  expect(actual.subarray(0, binStart).equals(expected.subarray(0, binStart)), 'header and JSON').toBe(true);

  const json = JSON.parse(expected.subarray(20, 20 + jsonLength).toString()) as {
    accessors: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[];
    bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  };
  const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const floatWord = new Uint8Array(Math.ceil((expected.length - binStart) / 4));
  for (const accessor of json.accessors) {
    if (accessor.componentType !== 5126 || accessor.bufferView === undefined) continue;
    const view = json.bufferViews[accessor.bufferView]!;
    const components = width[accessor.type]!;
    const stride = view.byteStride ?? components * 4;
    const first = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let element = 0; element < accessor.count; element++) {
      for (let component = 0; component < components; component++) {
        floatWord[(first + element * stride + component * 4) / 4] = 1;
      }
    }
  }

  const a = actual.subarray(binStart), e = expected.subarray(binStart);
  let differing = 0;
  for (let offset = 0; offset + 4 <= e.length; offset += 4) {
    if (a.readUInt32LE(offset) === e.readUInt32LE(offset)) continue;
    differing++;
    expect(floatWord[offset / 4], `non-float byte ${offset} changed`).toBe(1);
    const got = a.readFloatLE(offset), want = e.readFloatLE(offset);
    expect(Number.isFinite(got), `float at ${offset} is ${got}`).toBe(true);
    expect(Math.abs(got - want), `float at ${offset}: ${got} vs ${want}`).toBeLessThanOrEqual(1e-6 + 1e-6 * Math.abs(want));
  }
  for (let offset = e.length - (e.length % 4); offset < e.length; offset++) expect(a[offset]).toBe(e[offset]);
  expect(differing, 'differing float words').toBeLessThan(e.length / 4 / 100);
}
