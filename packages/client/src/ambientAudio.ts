import * as THREE from 'three';
import { atmosphereAt } from './environment.js';
import { patchCentre } from './space.js';
import type { PatchView } from './terrain.js';
import type { WindState } from './wind.js';

export interface AmbientLevels { rain: number; water: number; wind: number }
export interface AmbientView {
  x: number; z: number;
  visible(patch: PatchView): boolean;
}

/**
 * Saved seasonal rain, currently visible saved water, and the observer's wind (wind.ts: the
 * same season/shower mapping that sways the grass) drive this viewer effect. Nothing else.
 */
export function ambientLevels(season: string, patches: readonly PatchView[], view: AmbientView,
  wind: Pick<WindState, 'strength'> = { strength: 0 }): AmbientLevels {
  const rain = atmosphereAt(0, season).seasonRain;
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
  const strength = Number.isFinite(wind.strength) ? Math.max(0, Math.min(1, wind.strength)) : 0;
  return { rain, water, wind: Math.round(strength * 1000) / 1000 };
}

/** A synthesized call: oscillator or filtered-noise burst with a pitch and gain envelope. */
export interface CueVoice {
  /** 'tone' is an oscillator glide; 'noise' a band-passed burst of the shared noise buffer. */
  source: 'tone' | 'noise';
  wave?: OscillatorType;
  /** Start and end frequency, Hz. */
  from: number; to: number;
  seconds: number;
  /** Short repeated syllables (a squirrel's chatter); 1 for a single call. */
  pulses: number;
  gain: number;
}

/**
 * Which recorded states make which sound. Only alarm calls of prey that the simulation records
 * as fleeing, and the contact whistles/yips of pack hunters it records as chasing: real
 * behaviours that are audible. Stalking is silent, as are tigers, hares and vultures. These
 * are synthetic approximations, not recordings of the species.
 */
export const ANIMAL_CUES: Readonly<Record<string, Partial<Record<'fleeing' | 'chasing', CueVoice>>>> = {
  chital: { fleeing: { source: 'tone', wave: 'sawtooth', from: 1250, to: 760, seconds: 0.16, pulses: 1, gain: 0.5 } },
  sambar: { fleeing: { source: 'tone', wave: 'sawtooth', from: 420, to: 260, seconds: 0.32, pulses: 1, gain: 0.7 } },
  gaur: { fleeing: { source: 'noise', from: 380, to: 220, seconds: 0.45, pulses: 1, gain: 0.8 } },
  boar: { fleeing: { source: 'noise', from: 260, to: 180, seconds: 0.22, pulses: 2, gain: 0.6 } },
  langur: { fleeing: { source: 'tone', wave: 'square', from: 560, to: 380, seconds: 0.18, pulses: 2, gain: 0.45 } },
  squirrel: { fleeing: { source: 'tone', wave: 'square', from: 2400, to: 1900, seconds: 0.5, pulses: 6, gain: 0.3 } },
  elephant: { fleeing: { source: 'tone', wave: 'sawtooth', from: 520, to: 680, seconds: 0.9, pulses: 1, gain: 0.7 } },
  dhole: { chasing: { source: 'tone', wave: 'sine', from: 1500, to: 1900, seconds: 0.35, pulses: 1, gain: 0.4 } },
  jackal: { chasing: { source: 'tone', wave: 'triangle', from: 900, to: 1300, seconds: 0.2, pulses: 2, gain: 0.4 } },
};

export function cueFor(speciesId: string, state: string): CueVoice | null {
  return state === 'fleeing' || state === 'chasing' ? ANIMAL_CUES[speciesId]?.[state] ?? null : null;
}

/** An animal the observer can currently see, with its recorded state this moment. */
export interface AudioAnimal { id: string; speciesId: string; state: string; x: number; y: number; z: number }
export interface CueView {
  x: number; y: number; z: number;
  /** Whether a point projects into the view; -1 (left) to 1 (right) for stereo placement. */
  screen(point: { x: number; y: number; z: number }): { visible: boolean; pan: number };
}
export interface AnimalCue { id: string; speciesId: string; state: string; voice: CueVoice; gain: number; pan: number }
export interface CueMemory { state: string; lastMs: number }

/** Beyond this the observer hears nothing from an animal, metres. */
export const CUE_RANGE_M = 160;
/** A call repeats at most this often while the same recorded state lasts, ms. */
export const CUE_REPEAT_MS = 6_000;
/** At most this many calls start per sample (about once a second). */
export const MAX_CUES_PER_SAMPLE = 2;

/**
 * Which calls start now. A call needs: a species/state pair in ANIMAL_CUES, the animal on
 * screen and within CUE_RANGE_M, and either a fresh entry into that recorded state or
 * CUE_REPEAT_MS since its last call. Loudness falls with the square of distance. `memory` is
 * updated in place and forgets animals that are no longer calling.
 */
export function animalCues(animals: Iterable<AudioAnimal>, view: CueView, nowMs: number,
  memory: Map<string, CueMemory>): AnimalCue[] {
  const candidates: AnimalCue[] = [];
  const calling = new Set<string>();
  for (const animal of animals) {
    const voice = cueFor(animal.speciesId, animal.state);
    if (!voice) continue;
    const distance = Math.hypot(animal.x - view.x, animal.y - view.y, animal.z - view.z);
    if (!(distance <= CUE_RANGE_M)) continue;
    const { visible, pan } = view.screen(animal);
    if (!visible) continue;
    calling.add(animal.id);
    const previous = memory.get(animal.id);
    if (previous && previous.state === animal.state && nowMs - previous.lastMs < CUE_REPEAT_MS) continue;
    const near = 1 - distance / CUE_RANGE_M;
    candidates.push({ id: animal.id, speciesId: animal.speciesId, state: animal.state, voice, gain: voice.gain * near * near,
      pan: Math.max(-1, Math.min(1, pan)) });
  }
  for (const id of [...memory.keys()]) if (!calling.has(id)) memory.delete(id);
  candidates.sort((a, b) => b.gain - a.gain || (a.id < b.id ? -1 : 1));
  const chosen = candidates.slice(0, MAX_CUES_PER_SAMPLE);
  for (const cue of chosen) memory.set(cue.id, { state: cue.state, lastMs: nowMs });
  return chosen;
}

/** At most this many synthesized calls sound at once. */
export const MAX_VOICES = 4;

/**
 * One looping noise source shared by three filtered paths (rain, water, wind), plus short,
 * bounded synthesized animal calls. Nothing is created before a user click.
 */
export class AmbientAudio {
  #context: AudioContext | null = null;
  #source: AudioBufferSourceNode | null = null;
  #noise: AudioBuffer | null = null;
  #master: GainNode | null = null;
  #rainGain: GainNode | null = null;
  #waterGain: GainNode | null = null;
  #windGain: GainNode | null = null;
  #windFilter: BiquadFilterNode | null = null;
  #generation = 0;
  #lastSampleMs = -Infinity;
  readonly #cueMemory = new Map<string, CueMemory>();
  #voices = 0;
  enabled = false;

  get activeVoices(): number { return this.#voices; }

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
      // Wind: a low, breathy band whose centre rises a little in gusts.
      const windFilter = context.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 320;
      windFilter.Q.value = 0.7;
      const rainGain = context.createGain(); rainGain.gain.value = 0;
      const waterGain = context.createGain(); waterGain.gain.value = 0;
      const windGain = context.createGain(); windGain.gain.value = 0;
      const master = context.createGain(); master.gain.value = 0.08;
      source.connect(rainFilter).connect(rainGain).connect(master);
      source.connect(waterFilter).connect(waterGain).connect(master);
      source.connect(windFilter).connect(windGain).connect(master);
      master.connect(context.destination);
      this.#source = source; this.#noise = buffer; this.#master = master;
      this.#rainGain = rainGain; this.#waterGain = waterGain; this.#windGain = windGain; this.#windFilter = windFilter;
      source.start();
      await context.resume();
      if (generation !== this.#generation) return false;
      this.enabled = true; this.#lastSampleMs = -Infinity; this.#cueMemory.clear();
      return true;
    } catch { if (generation === this.#generation) this.stop(); return false; }
  }

  /** Stop immediately; the asynchronous close is deliberately not awaited by pagehide. */
  stop(): void {
    this.#generation++; this.enabled = false; this.#lastSampleMs = -Infinity;
    try { this.#source?.stop(); } catch { /* source may not have started */ }
    this.#source?.disconnect(); this.#rainGain?.disconnect(); this.#waterGain?.disconnect();
    this.#windGain?.disconnect(); this.#windFilter?.disconnect(); this.#master?.disconnect();
    this.#source = null; this.#rainGain = null; this.#waterGain = null; this.#windGain = null;
    this.#windFilter = null; this.#master = null; this.#noise = null;
    this.#cueMemory.clear(); this.#voices = 0;
    const context = this.#context; this.#context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => { /* browser is leaving */ });
  }

  /**
   * About once a second: ambience levels from the current saved scene and wind, and calls for
   * on-screen animals whose recorded state warrants one. `animals` is only read when sampling.
   */
  sample(season: string, patches: readonly PatchView[], camera: THREE.PerspectiveCamera,
    heightAt: (x: number, z: number) => number, nowMs: number,
    wind: Pick<WindState, 'strength'> = { strength: 0 }, animals: () => Iterable<AudioAnimal> = () => []): void {
    const context = this.#context;
    if (!this.enabled || !context || !this.#rainGain || !this.#waterGain || !this.#windGain
      || nowMs - this.#lastSampleMs < 900) return;
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
    }, wind);
    const at = context.currentTime;
    this.#rainGain.gain.setTargetAtTime(levels.rain * 0.52, at, 0.35);
    this.#waterGain.gain.setTargetAtTime(levels.water * 0.7, at, 0.35);
    // Quadratic: a still morning is near silent, a monsoon squall clearly audible.
    this.#windGain.gain.setTargetAtTime(levels.wind * levels.wind * 0.9, at, 0.8);
    this.#windFilter?.frequency.setTargetAtTime(240 + levels.wind * 260, at, 0.8);
    const cues = animalCues(animals(), {
      x: camera.position.x, y: camera.position.y, z: camera.position.z,
      screen: (p) => {
        point.set(p.x, p.y, p.z).project(camera);
        return { visible: point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1, pan: point.x };
      },
    }, nowMs, this.#cueMemory);
    for (const cue of cues) this.#play(context, cue);
  }

  #play(context: AudioContext, cue: AnimalCue): void {
    if (!this.#master || this.#voices >= MAX_VOICES) return;
    const { voice } = cue;
    const start = context.currentTime + 0.02, end = start + voice.seconds;
    const envelope = context.createGain(); envelope.gain.value = 0;
    const panner = context.createStereoPanner(); panner.pan.value = cue.pan;
    let sound: AudioScheduledSourceNode, shaped: AudioNode;
    if (voice.source === 'noise' && this.#noise) {
      const noise = context.createBufferSource(); noise.buffer = this.#noise; noise.loop = true;
      const band = context.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 4;
      band.frequency.setValueAtTime(voice.from, start); band.frequency.linearRampToValueAtTime(voice.to, end);
      noise.connect(band); sound = noise; shaped = band;
    } else {
      const tone = context.createOscillator(); tone.type = voice.wave ?? 'sine';
      tone.frequency.setValueAtTime(voice.from, start); tone.frequency.exponentialRampToValueAtTime(voice.to, end);
      sound = tone; shaped = tone;
    }
    // Each syllable: a 10 ms attack and a quick decay, so nothing clicks.
    const level = Math.max(0.0001, Math.min(1, cue.gain)) * 2.2;
    const pulse = voice.seconds / voice.pulses;
    for (let i = 0; i < voice.pulses; i++) {
      const t = start + i * pulse;
      envelope.gain.setValueAtTime(0, t);
      envelope.gain.linearRampToValueAtTime(level, t + 0.01);
      envelope.gain.linearRampToValueAtTime(0, t + pulse * 0.9);
    }
    shaped.connect(envelope).connect(panner).connect(this.#master);
    this.#voices++;
    const generation = this.#generation;
    sound.onended = () => {
      sound.disconnect(); shaped.disconnect(); envelope.disconnect(); panner.disconnect();
      if (generation === this.#generation) this.#voices = Math.max(0, this.#voices - 1);
    };
    sound.start(start); sound.stop(end + 0.05);
  }
}
