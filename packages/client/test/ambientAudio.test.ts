import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbientAudio, ambientLevels, animalCues, ANIMAL_CUES, CUE_RANGE_M, CUE_REPEAT_MS, cueFor, MAX_CUES_PER_SAMPLE,
  MAX_VOICES, type AudioAnimal, type CueMemory, type CueView } from '../src/ambientAudio.js';
import type { PatchView } from '../src/terrain.js';
import { windAt } from '../src/wind.js';
import { showerIntensity } from '@vana/shared';

const patch = (id: number, overrides: Partial<PatchView> = {}): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat: 'grassland', grass: 0, browse: 0, water: 0,
  ...overrides,
});
const visible = (x = 0, z = 0) => ({ x, z, visible: () => true });
/** First monsoon hour with a heavy shower: the windiest the observer's wind gets. */
const squallTime = (): number => {
  for (let t = 0; t < 400 * 3600; t += 600) if (showerIntensity(t, 'monsoon') > 0.9) return t;
  throw new Error('no squall');
};
const view = (onScreen = true): CueView => ({ x: 0, y: 10, z: 0, screen: (p) => ({ visible: onScreen, pan: p.x / 100 }) });
const animal = (id: string, speciesId: string, state: string, x = 20, z = 0): AudioAnimal =>
  ({ id, speciesId, state, x, y: 10, z });

describe('user-enabled ambient audio contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('derives seasonal rain only from the saved season, and wind only from the shared wind state', () => {
    expect(ambientLevels('monsoon', [], visible())).toEqual({ rain: 0.8, water: 0, wind: 0 });
    expect(ambientLevels('wet', [], visible()).rain).toBe(0.4);
    expect(ambientLevels('transition', [], visible()).rain).toBe(0.1);
    expect(ambientLevels('dry', [], visible())).toEqual({ rain: 0, water: 0, wind: 0 });
    expect(ambientLevels('unknown', [], visible())).toEqual({ rain: 0, water: 0, wind: 0 });
    // The same parameter that sways grass and leaves (wind.ts), clamped and never invented.
    const squall = windAt(squallTime(), 'monsoon');
    expect(ambientLevels('monsoon', [], visible(), squall).wind).toBe(squall.strength);
    expect(ambientLevels('dry', [], visible(), { strength: 4 }).wind).toBe(1);
    expect(ambientLevels('dry', [], visible(), { strength: Number.NaN }).wind).toBe(0);
  });

  it('uses only near, visible saved water and flow; empty or invented dry water stays silent', () => {
    const lake = patch(0, { habitat: 'water', water: 80_000 });
    expect(ambientLevels('dry', [lake], visible()).water).toBeGreaterThan(0);
    expect(ambientLevels('dry', [lake], { ...visible(), visible: () => false }).water).toBe(0);
    expect(ambientLevels('dry', [lake], visible(600, 0)).water).toBe(0);
    expect(ambientLevels('dry', [patch(0, { habitat: 'water', water: 0 })], visible()).water).toBe(0);
    expect(ambientLevels('dry', [patch(0, { surface: 'ocean' })], visible()).water).toBeGreaterThan(0);
    const river = patch(0, { drainage: { downstreamPatchId: 1, boundaryOutlet: false, inflowL: 0,
      outflowL: 4_000, hours: 1 } });
    expect(ambientLevels('dry', [river], visible()).water).toBeGreaterThan(0);
    expect(ambientLevels('dry', [patch(0, { ...river, drainage: { ...river.drainage!, outflowL: 25 } })], visible()).water).toBe(0);
  });

  it('allocates no Web Audio nodes before a click and bounds/cleans its graph after starting', async () => {
    const counts = { contexts: 0, buffers: 0, sources: 0, filters: 0, gains: 0, started: 0, stopped: 0, closed: 0 };
    const gainWrites: Array<ReturnType<typeof vi.fn>> = [];
    class Node {
      connect<T>(destination: T): T { return destination; }
      disconnect(): void {}
    }
    class FakeSource extends Node {
      buffer: unknown; loop = false;
      start(): void { counts.started++; }
      stop(): void { counts.stopped++; }
    }
    class FakeContext {
      sampleRate = 48_000; currentTime = 1; state = 'suspended'; destination = new Node();
      constructor() { counts.contexts++; }
      createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
        counts.buffers++; expect(length).toBe(96_000); return { getChannelData: () => new Float32Array(length) };
      }
      createBufferSource(): FakeSource { counts.sources++; return new FakeSource(); }
      createBiquadFilter() {
        counts.filters++;
        return Object.assign(new Node(), { type: '', frequency: { value: 0, setTargetAtTime: vi.fn() }, Q: { value: 0 } });
      }
      createGain() {
        counts.gains++; const write = vi.fn(); gainWrites.push(write);
        return Object.assign(new Node(), { gain: { value: 0, setTargetAtTime: write } });
      }
      async resume(): Promise<void> { this.state = 'running'; }
      async close(): Promise<void> { counts.closed++; this.state = 'closed'; }
    }
    vi.stubGlobal('AudioContext', FakeContext);
    const audio = new AmbientAudio();
    expect(audio.enabled).toBe(false);
    expect(counts.contexts).toBe(0);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000);
    audio.sample('monsoon', [patch(0, { habitat: 'water', water: 80_000 })], camera, () => 0, 1_000);
    expect(counts.contexts).toBe(0);
    expect(await audio.start()).toBe(true);
    expect(audio.enabled).toBe(true);
    // One noise source, three filtered paths (rain, water, wind) and a master gain.
    expect(counts).toMatchObject({ contexts: 1, buffers: 1, sources: 1, filters: 3, gains: 4, started: 1 });
    audio.sample('monsoon', [], camera, () => 0, 1_000);
    audio.sample('monsoon', [], camera, () => 0, 1_100);
    expect(gainWrites[0]).toHaveBeenCalledTimes(1);
    expect(gainWrites[1]).toHaveBeenCalledTimes(1);
    audio.sample('dry', [], camera, () => 0, 2_000);
    expect(gainWrites[0]).toHaveBeenCalledTimes(2);
    audio.stop();
    expect(audio.enabled).toBe(false);
    expect(counts).toMatchObject({ stopped: 1, closed: 1 });
    audio.sample('monsoon', [], camera, () => 0, 3_000);
    expect(gainWrites[0]).toHaveBeenCalledTimes(2);
  });

  it('exposes an accessible off-by-default toggle and shuts down on hidden/pagehide', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(html).toContain('id="ambient-toggle" type="button" aria-pressed="false"');
    expect(html).toContain('Off by default, no autoplay');
    expect(html).toContain('only from visible animals the simulation records as fleeing or hunting');
    expect(main).toContain("ambientToggle.addEventListener('click'");
    expect(main).toContain("document.addEventListener('visibilitychange'");
    expect(main).toContain("addEventListener('pagehide'");
    expect(main).toContain('ambientAudio.stop()');
    expect(main).not.toContain("storage?.setItem('vana.audio'");
  });

  it('calls only for visible, nearby animals in a recorded fleeing or hunting state', () => {
    const memory = new Map<string, CueMemory>();
    // Ordinary or silent states never make a sound; stalking hunters are silent too.
    for (const state of ['resting', 'travelling', 'grazing', 'drinking', 'stalking', 'dead', 'feeding'])
      expect(animalCues([animal('a', 'chital', state)], view(), 0, memory)).toEqual([]);
    expect(cueFor('chital', 'fleeing')).not.toBeNull();
    expect(cueFor('dhole', 'chasing')).not.toBeNull();
    // A tiger hunts silently; a fleeing hare has no call; prey are not given hunting calls.
    expect(cueFor('tiger', 'chasing')).toBeNull();
    expect(cueFor('hare', 'fleeing')).toBeNull();
    expect(cueFor('chital', 'chasing')).toBeNull();
    expect(cueFor('dhole', 'fleeing')).toBeNull();
    expect(animalCues([animal('t', 'tiger', 'chasing'), animal('h', 'hare', 'fleeing')], view(), 0, memory)).toEqual([]);
    // Off screen or out of range: silent.
    expect(animalCues([animal('a', 'chital', 'fleeing')], view(false), 0, memory)).toEqual([]);
    expect(animalCues([animal('a', 'chital', 'fleeing', CUE_RANGE_M + 1)], view(), 0, memory)).toEqual([]);
    const [cue] = animalCues([animal('a', 'chital', 'fleeing', 30)], view(), 0, memory);
    expect(cue).toMatchObject({ id: 'a', speciesId: 'chital', state: 'fleeing', voice: ANIMAL_CUES.chital!.fleeing, pan: 0.3 });
    expect(cue!.gain).toBeCloseTo(ANIMAL_CUES.chital!.fleeing!.gain * (1 - 30 / CUE_RANGE_M) ** 2);
  });

  it('attenuates with distance, repeats sparingly and bounds how many calls start at once', () => {
    const memory = new Map<string, CueMemory>();
    const near = animalCues([animal('n', 'sambar', 'fleeing', 10)], view(), 0, new Map())[0]!;
    const far = animalCues([animal('f', 'sambar', 'fleeing', 120)], view(), 0, new Map())[0]!;
    expect(near.gain).toBeGreaterThan(far.gain * 10);
    const herd = Array.from({ length: 8 }, (_, i) => animal(`c${i}`, 'chital', 'fleeing', 10 + i * 5));
    const first = animalCues(herd, view(), 0, memory);
    expect(first.map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(first).toHaveLength(MAX_CUES_PER_SAMPLE);
    // The next sample lets the next-loudest call; the first callers wait out the repeat.
    expect(animalCues(herd, view(), 1_000, memory).map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(animalCues(herd.slice(0, 2), view(), CUE_REPEAT_MS - 1, memory)).toEqual([]);
    expect(animalCues(herd.slice(0, 2), view(), CUE_REPEAT_MS, memory).map((c) => c.id)).toEqual(['c0', 'c1']);
    // An animal newly recorded in a calling state (a jackal starting a chase) calls at once.
    const jackal = [animal('j', 'jackal', 'chasing', 15)];
    expect(animalCues(jackal, view(), 0, memory)).toHaveLength(1);
    expect(animalCues(jackal, view(), 100, memory)).toHaveLength(0);
    // Forgotten once it stops: a later flight is a fresh call.
    animalCues([], view(), 200, memory);
    expect(memory.size).toBe(0);
    expect(animalCues(jackal, view(), 300, memory)).toHaveLength(1);
  });

  it('synthesizes calls into a bounded number of voices that release their nodes', async () => {
    const created: Array<{ onended: (() => void) | null; disconnect: ReturnType<typeof vi.fn> }> = [];
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() });
    class Node {
      disconnect = vi.fn();
      connect<T>(destination: T): T { return destination; }
    }
    class Scheduled extends Node {
      onended: (() => void) | null = null; buffer: unknown; loop = false; type = ''; frequency = param();
      start(): void {} stop(): void {}
      constructor() { super(); created.push(this); }
    }
    class FakeContext {
      sampleRate = 8_000; currentTime = 0; state = 'running'; destination = new Node();
      createBuffer(_c: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
      createBufferSource() { return new Scheduled(); }
      createOscillator() { return new Scheduled(); }
      createBiquadFilter() { return Object.assign(new Node(), { type: '', frequency: param(), Q: { value: 0 } }); }
      createGain() { return Object.assign(new Node(), { gain: param() }); }
      createStereoPanner() { return Object.assign(new Node(), { pan: param() }); }
      async resume(): Promise<void> {}
      async close(): Promise<void> { this.state = 'closed'; }
    }
    vi.stubGlobal('AudioContext', FakeContext);
    const audio = new AmbientAudio();
    expect(await audio.start()).toBe(true);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000);
    camera.position.set(0, 10, 30); camera.lookAt(0, 10, 0);
    const herd = () => Array.from({ length: 6 }, (_, i) => animal(`c${i}`, i % 2 ? 'gaur' : 'chital', 'fleeing', i * 2 - 5, 0));
    let t = 0;
    for (let i = 0; i < 4; i++) audio.sample('dry', [], camera, () => 0, t += 1_000, { strength: 0.2 }, herd);
    expect(audio.activeVoices).toBe(MAX_VOICES);
    const voices = created.slice(1); // The first scheduled node is the looping ambience source.
    expect(voices).toHaveLength(MAX_VOICES);
    for (const voice of voices) voice.onended!();
    expect(audio.activeVoices).toBe(0);
    for (const voice of voices) expect(voice.disconnect).toHaveBeenCalled();
    audio.stop();
  });
});

describe('forest sound beds', async () => {
  const { bedLevels, BED_FILES } = await import('../src/ambientAudio.js');
  const { readFileSync } = await import('node:fs');
  it('plays insects and birds by day, frogs and crickets by night, and crossfades through dusk', () => {
    expect(bedLevels(1, 0, 5)).toMatchObject({ day: 1, night: 0, rain: 0 });
    expect(bedLevels(0, 0, 5)).toMatchObject({ day: 0, night: 1 });
    const dusk = bedLevels(0.5, 0, 5);
    expect(dusk.day).toBeCloseTo(0.5); expect(dusk.night).toBeCloseTo(0.5);
  });
  it('brings rain on the leaves in with the season\'s rain, a little over the creatures', () => {
    const wet = bedLevels(1, 1, 5);
    expect(wet.rain).toBe(1);
    expect(wet.day).toBeCloseTo(0.5);
  });
  it('softens everything as the eye rises over the forest, never to nothing', () => {
    const high = bedLevels(1, 1, 1000);
    expect(high.day).toBeCloseTo(0.25 * 0.5);
    expect(high.rain).toBeCloseTo(0.4 + 0.6 * 0.25);
    expect(bedLevels(1, 0, 40).day).toBe(1);
  });
  it('ships each bed as a small MP3 in the public assets', () => {
    for (const file of Object.values(BED_FILES)) {
      const bytes = readFileSync(new URL(`../public${file}`, import.meta.url));
      expect(bytes.length).toBeLessThan(300_000);
      expect(bytes.toString('latin1', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)).toBe(true);
    }
  });
});
