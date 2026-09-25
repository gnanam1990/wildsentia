import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmbientAudio, ambientLevels } from '../src/ambientAudio.js';
import type { PatchView } from '../src/terrain.js';

const patch = (id: number, overrides: Partial<PatchView> = {}): PatchView => ({
  id, x: id % 20, y: Math.floor(id / 20), habitat: 'grassland', grass: 0, browse: 0, water: 0,
  ...overrides,
});
const visible = (x = 0, z = 0) => ({ x, z, visible: () => true });

describe('user-enabled ambient audio contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('derives seasonal rain only from the saved season and never invents wind', () => {
    expect(ambientLevels('monsoon', [], visible())).toEqual({ rain: 0.8, water: 0, wind: 0 });
    expect(ambientLevels('wet', [], visible()).rain).toBe(0.4);
    expect(ambientLevels('transition', [], visible()).rain).toBe(0.1);
    expect(ambientLevels('dry', [], visible())).toEqual({ rain: 0, water: 0, wind: 0 });
    expect(ambientLevels('unknown', [], visible())).toEqual({ rain: 0, water: 0, wind: 0 });
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
      createBiquadFilter() { counts.filters++; return Object.assign(new Node(), { type: '', frequency: { value: 0 } }); }
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
    expect(counts).toMatchObject({ contexts: 1, buffers: 1, sources: 1, filters: 2, gains: 3, started: 1 });
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
    expect(html).toContain('No animal sounds or autoplay');
    expect(main).toContain("ambientToggle.addEventListener('click'");
    expect(main).toContain("document.addEventListener('visibilitychange'");
    expect(main).toContain("addEventListener('pagehide'");
    expect(main).toContain('ambientAudio.stop()');
    expect(main).not.toContain("storage?.setItem('vana.audio'");
  });
});
