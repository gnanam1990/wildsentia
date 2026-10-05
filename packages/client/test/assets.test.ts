import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelStatus } from '../src/species.js';

function manifest(file: string) {
  const buffer = readFileSync(new URL(`../public/assets/animals/${file}`, import.meta.url));
  expect(buffer.subarray(0, 4).toString()).toBe('glTF');
  expect(buffer.readUInt32LE(8)).toBe(buffer.length);
  return JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString()) as {
    skins?: unknown[]; animations?: Array<{ name: string; channels: unknown[] }>; images?: unknown[];
  };
}

describe('generated species replacements', () => {
  // Generated from photoreal reference views and bound to existing rigs by
  // tools/art/build_species.sh; reviews in docs/art-review/species-2026-10-05.
  const quadruped = ['Idle', 'Walk', 'Gallop', 'Eating', 'Death'];
  const small = ['Idle', 'Walk', 'Run', 'Eating', 'Drinking', 'Death'];
  it.each([
    ['WildBoar', [...quadruped, 'Idle_Headlow']], ['Chital', [...quadruped, 'Idle_Headlow']],
    ['Sambar', [...quadruped, 'Idle_Headlow']], ['Gaur', [...quadruped, 'Idle_Headlow']],
    ['Dhole', [...quadruped, 'Idle_2_HeadLow']], ['Jackal', [...quadruped, 'Idle_2_HeadLow']],
    ['GreyLangur', small], ['GiantSquirrel', small], ['WhiteRumpedVulture', ['Idle', 'Walk', 'Eating', 'Drinking', 'Death']],
  ] as const)('%s keeps the rig clips the observer plays and stays within its byte budget', (name, clips) => {
    const gltf = manifest(`${name}.glb`);
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.animations!.map((a) => a.name)).toEqual(expect.arrayContaining([...clips]));
    expect(readFileSync(new URL(`../public/assets/animals/${name}.glb`, import.meta.url)).length).toBeLessThan(2_000_000);
  });
});

describe('free local character assets', () => {
  it.each(['TigerRigged', 'ElephantWalking', 'Langur', 'Squirrel', 'Vulture', 'WildBoar', 'Chital', 'Sambar', 'Gaur', 'Dhole', 'Jackal', 'GreyLangur', 'GiantSquirrel', 'WhiteRumpedVulture'])('%s contains finite, normalized skin weights and actual changing motion', (name) => {
    const buffer = readFileSync(new URL(`../public/assets/animals/${name}.glb`, import.meta.url));
    const jsonLength = buffer.readUInt32LE(12);
    const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
    const binaryOffset = 28 + jsonLength;
    const components: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };
    const values = (index: number): number[][] => {
      const a = gltf.accessors[index]; const view = gltf.bufferViews[a.bufferView];
      expect(a.componentType).toBe(5126);
      const count = components[a.type]!;
      const start = binaryOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
      return Array.from({ length: a.count }, (_, i) => Array.from({ length: count }, (_, c) =>
        buffer.readFloatLE(start + i * (view.byteStride ?? count * 4) + c * 4)));
    };
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
      expect(primitive.attributes.WEIGHTS_0).toBeDefined();
      for (const weights of values(primitive.attributes.WEIGHTS_0)) {
        expect(weights.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
      }
    }
    for (const clip of gltf.animations) {
      let changing = false;
      for (const sampler of clip.samplers) {
        const times = values(sampler.input).flat();
        expect(times.at(-1)).toBeGreaterThan(0);
        const samples = values(sampler.output);
        expect(samples.flat().every(Number.isFinite)).toBe(true);
        if (samples.some((sample) => sample.some((value, c) => Math.abs(value - samples[0]![c]!) > 1e-5))) changing = true;
      }
      expect(changing, `${name}: ${clip.name}`).toBe(true);
    }
  });
  it('preserves the original elephant and adds a skinned local walk derivative', () => {
    const gltf = manifest('Elephant.glb');
    expect(gltf.skins?.length).toBeGreaterThan(0);
    for (const name of ['Idle', 'Eating']) expect(gltf.animations?.find((a) => a.name === name)?.channels.length).toBeGreaterThan(0);
    expect(gltf.animations?.some((a) => a.name === 'Walk')).toBe(false);
    const walking = manifest('ElephantWalking.glb');
    expect(walking.skins?.length).toBeGreaterThan(0);
    for (const name of ['Idle', 'Eating', 'Walk']) expect(walking.animations?.find((a) => a.name === name)?.channels.length).toBeGreaterThan(0);
    expect(modelStatus('elephant')).toContain('gait polish pending');
  });
  it('ships rabbit skin, textures and running/death clips while labelling the approximation', () => {
    const gltf = manifest('Rabbit.glb');
    expect(gltf.skins?.length).toBeGreaterThan(0);
    expect(gltf.images?.length).toBe(3);
    // A 22 cm hare needs no 1024 px textures: shrunk once by tools/assets/shrink_rabbit_textures.py,
    // with the alpha-masked fur kept as PNG and only image bytes changed.
    const budget = (gltf.asset as { extras?: { textureBudget?: { sourceSha256?: string } } }).extras?.textureBudget;
    expect(budget?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gltf.images?.find((i: { name?: string }) => i.name === 'Fur-skin')?.mimeType).toBe('image/png');
    expect(readFileSync(new URL('../public/assets/animals/Rabbit.glb', import.meta.url)).length).toBeLessThan(2_200_000);
    for (const name of ['Idle', 'Gallop', 'Death']) expect(gltf.animations?.find((a) => a.name === name)?.channels.length).toBeGreaterThan(0);
    expect(modelStatus('hare')).toContain('approximation');
  });
  it.each(['Langur', 'Squirrel', 'Vulture'])('ships %s with a real skin and authored state clips, labelled as unfinished art', (name) => {
    const gltf = manifest(`${name}.glb`);
    expect(gltf.skins?.length).toBeGreaterThan(0);
    for (const clip of ['Idle', 'Walk', 'Eating', 'Drinking', 'Death']) expect(gltf.animations?.find((a) => a.name === clip)?.channels.length).toBeGreaterThan(0);
    expect(modelStatus(name.toLowerCase())).toContain('anatomical polish pending');
  });
  it('the local vulture has actual bilateral wing motion for Flap and an extended Glide pose', () => {
    const bytes = readFileSync(new URL('../public/assets/animals/Vulture.glb', import.meta.url));
    const jsonLength = bytes.readUInt32LE(12), binaryStart = 28 + jsonLength;
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    const joints = gltf.skins[0].joints.map((index: number) => gltf.nodes[index].name);
    for (const name of ['wing-1', 'tip-1', 'wing1', 'tip1']) expect(joints).toContain(name);
    const wingChange = (clipName: string, jointName: string): number => {
      const clip = gltf.animations.find((animation: { name: string }) => animation.name === clipName);
      const channel = clip.channels.find((c: { target: { node: number; path: string } }) =>
        gltf.nodes[c.target.node].name === jointName && c.target.path === 'rotation');
      expect(channel).toBeDefined();
      const accessor = gltf.accessors[clip.samplers[channel.sampler].output];
      const view = gltf.bufferViews[accessor.bufferView];
      const offset = binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const first = Array.from({ length: 4 }, (_, component) => bytes.readFloatLE(offset + component * 4));
      let change = 0;
      for (let frame = 0; frame < accessor.count; frame++) for (let component = 0; component < 4; component++) {
        const value = bytes.readFloatLE(offset + frame * (view.byteStride ?? 16) + component * 4);
        change = Math.max(change, Math.abs(value - first[component]!));
      }
      return change;
    };
    for (const side of ['wing-1', 'wing1']) {
      expect(wingChange('Flap', side)).toBeGreaterThan(0.5);
      expect(wingChange('Glide', side)).toBeLessThan(0.05);
    }
    for (const unavailable of ['Takeoff', 'Landing'])
      expect(gltf.animations.some((animation: { name: string }) => animation.name === unavailable)).toBe(false);
  });
  it('preserves the static tiger source and ships an explicitly local rig, not the blocked download', () => {
    expect(manifest('Tiger.glb').skins?.length ?? 0).toBe(0);
    const gltf = manifest('TigerRigged.glb');
    expect(gltf.skins?.length).toBeGreaterThan(0);
    expect(gltf.images?.length).toBeGreaterThan(0);
    for (const name of ['Idle', 'Walk', 'Run', 'Sneak', 'Eating', 'Drinking', 'Death']) expect(gltf.animations?.find((a) => a.name === name)?.channels.length).toBeGreaterThan(0);
    expect(modelStatus('tiger')).toContain('Local tiger rig');
    expect(modelStatus('tiger')).toContain('polish pending');
  });
});
