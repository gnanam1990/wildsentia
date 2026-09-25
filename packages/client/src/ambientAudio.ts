import * as THREE from 'three';
import { atmosphereAt } from './environment.js';
import { patchCentre } from './space.js';
import type { PatchView } from './terrain.js';

export interface AmbientLevels { rain: number; water: number; wind: 0 }
export interface AmbientView {
  x: number; z: number;
  visible(patch: PatchView): boolean;
}

/** Only saved seasonal rain and currently visible saved water can drive this viewer effect. */
export function ambientLevels(season: string, patches: readonly PatchView[], view: AmbientView): AmbientLevels {
  const rain = atmosphereAt(0, season).rain;
  let water = 0;
  for (const patch of patches) {
    const { x, z } = patchCentre(patch.id);
    const distance = Math.hypot(x - view.x, z - view.z);
    if (distance >= 450 || !view.visible(patch)) continue;
    const proximity = Math.max(0, 1 - distance / 450);
    const ocean = patch.surface === 'ocean' ? 0.36 : 0;
    const pool = patch.surface !== 'coast' && patch.surface !== 'ocean'
      && (patch.habitat === 'water' || patch.water > 20_000)
      ? Math.min(0.65, Math.max(0, patch.water) / 80_000) : 0;
    const flow = patch.drainage && patch.drainage.downstreamPatchId !== null && patch.drainage.outflowL > 25
      ? Math.min(0.85, patch.drainage.outflowL / 4_000) : 0;
    water = Math.max(water, Math.max(ocean, pool, flow) * proximity);
  }
  // There is no authoritative wind speed or direction in the saved scene.
  return { rain, water, wind: 0 };
}

/** A single bounded noise source shared by two filtered paths. Never created before a user click. */
export class AmbientAudio {
  #context: AudioContext | null = null;
  #source: AudioBufferSourceNode | null = null;
  #rainGain: GainNode | null = null;
  #waterGain: GainNode | null = null;
  #generation = 0;
  #lastSampleMs = -Infinity;
  enabled = false;

  async start(): Promise<boolean> {
    if (this.enabled) return true;
    if (typeof AudioContext === 'undefined') return false;
    const generation = ++this.#generation;
    let context: AudioContext;
    try { context = new AudioContext({ latencyHint: 'playback' }); }
    catch { return false; }
    this.#context = context;
    try {
      const length = Math.round(context.sampleRate * 2);
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const samples = buffer.getChannelData(0);
      let state = 0x7261696e;
      for (let i = 0; i < samples.length; i++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        samples[i] = (state / 0x7fffffff) * 0.5;
      }
      // Smooth only the loop seam; no timer, worklet, network file or per-frame synthesis.
      const seam = samples[0]!;
      for (let i = 0; i < 128; i++) {
        const blend = (i + 1) / 128;
        samples[length - 128 + i] = samples[length - 128 + i]! * (1 - blend) + seam * blend;
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
      const rainFilter = context.createBiquadFilter(); rainFilter.type = 'highpass'; rainFilter.frequency.value = 850;
      const waterFilter = context.createBiquadFilter(); waterFilter.type = 'lowpass'; waterFilter.frequency.value = 540;
      const rainGain = context.createGain(); rainGain.gain.value = 0;
      const waterGain = context.createGain(); waterGain.gain.value = 0;
      const master = context.createGain(); master.gain.value = 0.08;
      source.connect(rainFilter).connect(rainGain).connect(master);
      source.connect(waterFilter).connect(waterGain).connect(master);
      master.connect(context.destination);
      this.#source = source; this.#rainGain = rainGain; this.#waterGain = waterGain;
      source.start();
      await context.resume();
      if (generation !== this.#generation) return false;
      this.enabled = true; this.#lastSampleMs = -Infinity;
      return true;
    } catch { if (generation === this.#generation) this.stop(); return false; }
  }

  /** Stop immediately; the asynchronous close is deliberately not awaited by pagehide. */
  stop(): void {
    this.#generation++; this.enabled = false; this.#lastSampleMs = -Infinity;
    try { this.#source?.stop(); } catch { /* source may not have started */ }
    this.#source?.disconnect(); this.#rainGain?.disconnect(); this.#waterGain?.disconnect();
    this.#source = null; this.#rainGain = null; this.#waterGain = null;
    const context = this.#context; this.#context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => { /* browser is leaving */ });
  }

  sample(season: string, patches: readonly PatchView[], camera: THREE.PerspectiveCamera,
    heightAt: (x: number, z: number) => number, nowMs: number): void {
    const context = this.#context;
    if (!this.enabled || !context || !this.#rainGain || !this.#waterGain || nowMs - this.#lastSampleMs < 900) return;
    this.#lastSampleMs = nowMs;
    camera.updateMatrixWorld();
    const point = new THREE.Vector3();
    const levels = ambientLevels(season, patches, {
      x: camera.position.x, z: camera.position.z,
      visible: (patch) => {
        const centre = patchCentre(patch.id);
        point.set(centre.x, patch.surface === 'ocean' ? 0 : heightAt(centre.x, centre.z) + 0.2, centre.z).project(camera);
        return point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1.08 && Math.abs(point.y) <= 1.08;
      },
    });
    const at = context.currentTime;
    this.#rainGain.gain.setTargetAtTime(levels.rain * 0.52, at, 0.35);
    this.#waterGain.gain.setTargetAtTime(levels.water * 0.7, at, 0.35);
  }
}
