import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimalLayer } from '../src/animals.js';
import type { AnimalState } from '../src/protocol.js';
import { HOP_DURATION_MS } from '../src/space.js';
import type { LivePose } from '../src/liveEncounters.js';

const animal = (id: string, x = 0): AnimalState => ({ id, speciesId: 'chital', patchId: 0,
  position: { x, z: 0, heading: .5 }, state: 'resting', currentGoal: 'rest', drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } });
function model() {
  const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return { scene, animations: [] };
}
// Wait for the on-demand parser request and all model continuations before restoring its mock.
const ready = async (layer: AnimalLayer): Promise<void> => {
  await vi.waitFor(() => expect(layer.pendingModelCount).toBe(0), { timeout: 1000, interval: 2 });
};
afterEach(() => vi.restoreAllMocks());

describe('animal layer render lifecycle', () => {
  it('grounds a corpse without a death clip and restores the standing pose in replay', async () => {
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(model() as never);
    const layer = new AnimalLayer(); layer.groundHeightAt = () => 10;
    const living = { ...animal('corpse'), speciesId: 'elephant', sex: 'male' as const,
      lifeStage: 'adult' as const, state: 'dead', sizeRatio: 0.7 };
    layer.sync(new Map([['corpse', living]]), 0, 'corpse', { x: 0, z: 0 });
    await ready(layer); layer.sync(new Map([['corpse', living]]), 1, 'corpse', { x: 0, z: 0 });
    const rig = layer.root.getObjectByName('corpse')!;
    const visual = rig.children[0]!;
    expect(visual.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(new THREE.Box3().setFromObject(visual).min.y).toBeCloseTo(10, 5);
    layer.syncReplay({ ...living, state: 'resting' }, { x: 0, z: 0, heading: 0, moving: false }, 0);
    expect(visual.rotation.z).not.toBeCloseTo(Math.PI / 2);
    expect(new THREE.Box3().setFromObject(visual).min.y).toBeCloseTo(10, 5);
    layer.sync(new Map(), 2, null, { x: 0, z: 0 });
  });
  it('grounds an elephant after clearing its previous walk pose', async () => {
    const scene = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    body.name = 'body'; scene.add(body);
    const walk = new THREE.AnimationClip('Walk', 1,
      [new THREE.NumberKeyframeTrack('body.position[y]', [0, 1], [0, 0.5])]);
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene, animations: [walk] } as never);
    const layer = new AnimalLayer(); layer.groundHeightAt = () => 4;
    const walking = { ...animal('elephant'), speciesId: 'elephant', sex: 'female' as const,
      lifeStage: 'adult' as const, state: 'travelling' };
    layer.sync(new Map([['elephant', walking]]), 0, 'elephant', { x: 0, z: 0 });
    await ready(layer); layer.sync(new Map([['elephant', walking]]), 1, 'elephant', { x: 0, z: 0 });
    layer.update(0.5);
    const dead = { ...walking, state: 'dead' };
    layer.sync(new Map([['elephant', dead]]), 2, 'elephant', { x: 0, z: 0 });
    const visual = layer.root.getObjectByName('elephant')!.children[0]!;
    expect(new THREE.Box3().setFromObject(visual).min.y).toBeCloseTo(4, 5);
    layer.sync(new Map(), 3, null, { x: 0, z: 0 });
  });
  it('replaces the cached elephant rig when the displayed variant changes', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(model() as never);
    const layer = new AnimalLayer();
    const male = { ...animal('e'), speciesId: 'elephant', sex: 'male' as const, lifeStage: 'adult' as const };
    layer.sync(new Map([['e', male]]), 0, 'e', { x: 0, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('/assets/animals/AsianElephantAdultMale.glb'));
    await ready(layer); layer.sync(new Map([['e', male]]), 1, 'e', { x: 0, z: 0 });
    expect(layer.root.getObjectByName('e')).toBeDefined();

    const female = { ...male, sex: 'female' as const };
    layer.sync(new Map([['e', female]]), 2, 'e', { x: 0, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('/assets/animals/AsianElephantAdultFemale.glb'));
    await ready(layer); layer.sync(new Map([['e', female]]), 3, 'e', { x: 0, z: 0 });
    expect(layer.root.children.filter(child => child.name === 'e')).toHaveLength(1);
    const young = { ...female, lifeStage: 'juvenile' as const };
    layer.sync(new Map([['e', young]]), 4, 'e', { x: 0, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('/assets/animals/AsianElephantCalf.glb'));
    await ready(layer); layer.sync(new Map([['e', young]]), 5, 'e', { x: 0, z: 0 });
    expect(layer.root.children.filter(child => child.name === 'e')).toHaveLength(1);
    layer.sync(new Map(), 6, null, { x: 0, z: 0 });
  });
  it('retains the elephant surface grade on the live per-animal material', async () => {
    const map = new THREE.DataTexture(new Uint8Array([90, 60, 48, 255]), 1, 1);
    const source = new THREE.MeshStandardMaterial({ map });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), source));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene, animations: [] } as never);
    const layer = new AnimalLayer();
    const elephant = { ...animal('graded'), speciesId: 'elephant', sex: 'female' as const,
      lifeStage: 'adult' as const };
    const animals = new Map([['graded', elephant]]);
    layer.sync(animals, 0, 'graded', { x: 0, z: 0 });
    await ready(layer); layer.sync(animals, 1, 'graded', { x: 0, z: 0 });
    const rig = layer.root.getObjectByName('graded')!;
    const material = (rig.children[0] as THREE.Group).children[0] as THREE.Mesh;
    expect((material.material as THREE.Material).customProgramCacheKey()).toBe('vana-elephant-earth-grey-v2');
    expect(source.customProgramCacheKey()).not.toBe('vana-elephant-earth-grey-v2');
    layer.sync(new Map(), 2, null, { x: 0, z: 0 });
  });
  it('stands a recorded langur climb upright on its trunk above terrain, gripping with its walk cycle', async () => {
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const paw = new THREE.Group(); paw.name = 'paw'; scene.add(paw);
    const clip = (name: string, value: number) => new THREE.AnimationClip(name, 2,
      [new THREE.NumberKeyframeTrack('paw.position[x]', [0, 1, 2], [value, value, value])]);
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene,
      animations: [clip('Idle', 1), clip('Walk', 5)] } as never);
    const layer = new AnimalLayer(); layer.groundHeightAt = () => 10;
    const current = { ...animal('l'), speciesId: 'langur', locomotionMode: 'climb' as const,
      altitudeM: 6, state: 'travelling' };
    const living = new Map([['l', current]]);
    const position = { x: 0, z: 0, heading: 0, altitudeM: 3, moving: true };
    const pose: LivePose = { kind: 'movement', animal: current, position,
      seconds: .5, partnerId: '', eventId: 'tree', phase: 'recorded route', climbVisualPhase: 'ascending' };
    const poses = new Map([['l', pose]]);
    layer.sync(living, 0, 'l', { x: 0, z: 0 }, poses);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer); layer.sync(living, 1, 'l', { x: 0, z: 0 }, poses);
    const rig = layer.root.getObjectByName('l')!;
    expect(rig.position.y).toBe(13);
    expect(rig.getObjectByName('paw')!.position.x).toBe(5); // Walk, as hand-over-hand gripping.
    const visual = rig.children[0]!;
    expect(visual.rotation.x).toBeCloseTo(-Math.PI / 2); // upright, belly to the trunk
    expect(visual.position.z).toBeLessThan(0); // held clear of the trunk's centre
    delete pose.climbVisualPhase;
    layer.sync(living, 2, 'l', { x: 0, z: 0 }, poses);
    expect(visual.rotation.x).toBeCloseTo(0);
    expect(visual.position.z).toBeCloseTo(0);
    expect(rig.getObjectByName('paw')!.position.x).not.toBe(5);
    layer.sync(new Map(), 3, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('keeps the model root rotation (an export axis fix) when nothing is climbing', async () => {
    // The Asian elephant ships with a Sketchfab root turned -90 degrees about X; an earlier climb
    // reset zeroed it and drew every elephant on its side beneath the ground.
    const scene = new THREE.Group(); scene.rotation.x = -Math.PI / 2;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene, animations: [] } as never);
    const layer = new AnimalLayer(new THREE.Texture()); layer.groundHeightAt = () => 0;
    const living = new Map([['e', { ...animal('e'), speciesId: 'gaur' }]]);
    layer.sync(living, 0, 'e', { x: 0, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer); layer.sync(living, 1, 'e', { x: 0, z: 0 }); layer.sync(living, 2, 'e', { x: 0, z: 0 });
    expect(layer.root.getObjectByName('e')!.children[0]!.rotation.x).toBeCloseTo(-Math.PI / 2);
    layer.sync(new Map(), 3, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('samples real Flap/Glide clips only for recorded vulture phases, not a later checkpoint state', async () => {
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const wing = new THREE.Group(); wing.name = 'wing'; scene.add(wing);
    const clip = (name: string, values: number[]) => new THREE.AnimationClip(name, 2,
      [new THREE.NumberKeyframeTrack('wing.position[x]', [0, 1, 2], values)]);
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene,
      animations: [clip('Flap', [0, 1, 0]), clip('Glide', [2, 2, 2]), clip('Walk', [3, 3, 3]), clip('Death', [4, 4, 4])] } as never);
    const layer = new AnimalLayer();
    const current = { ...animal('v'), speciesId: 'vulture', state: 'dead' };
    const living = new Map([['v', current]]);
    const recorded = { ...current, state: 'travelling' };
    const position = { x: 0, z: 0, heading: 0, moving: true, altitudeM: 30 };
    const poses = new Map<string, LivePose>([['v', { kind: 'movement', animal: recorded, position,
      seconds: .5, partnerId: '', eventId: 'flight', phase: 'recorded route', flightVisualPhase: 'ascending' }]]);
    layer.sync(living, 0, 'v', { x: 0, z: 0 }, poses);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer);
    const wingX = () => layer.root.getObjectByName('v')!.getObjectByName('wing')!.position.x;
    layer.sync(living, 1, 'v', { x: 0, z: 0 }, poses);
    // Each animal has its own phase in a clip, so only the clip's range is fixed: Flap is 0..1,
    // where Glide, Walk and Death hold 2, 3 and 4.
    const flapping = () => { expect(wingX()).toBeGreaterThanOrEqual(0); expect(wingX()).toBeLessThanOrEqual(1); };
    flapping();
    poses.get('v')!.flightVisualPhase = 'gliding'; poses.get('v')!.seconds = 1;
    layer.sync(living, 2, 'v', { x: 0, z: 0 }, poses);
    expect(wingX()).toBeCloseTo(2);
    poses.get('v')!.flightVisualPhase = 'descending'; poses.get('v')!.seconds = 1.5;
    layer.sync(living, 3, 'v', { x: 0, z: 0 }, poses);
    flapping();
    delete poses.get('v')!.flightVisualPhase;
    layer.sync(living, 4, 'v', { x: 0, z: 0 }, poses);
    expect(wingX()).not.toBeCloseTo(3); // unknown airborne segment must not walk mid-air
    expect(wingX()).not.toBeCloseTo(4); // later checkpoint death must not leak into this route
    layer.sync(new Map(), 5, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('places elevated recorded rigs at the same height as the camera and distant representation', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(model() as never);
    const layer = new AnimalLayer(); layer.groundHeightAt = () => 12;
    const subject = animal('bird');
    const position = { x: 0, z: 0, heading: 1, moving: true, altitudeM: 35 };
    layer.syncReplay(subject, position, 0);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer); layer.syncReplay(subject, position, 0);
    expect(layer.root.getObjectByName('bird')!.position.y).toBe(47);
    layer.syncReplay(subject, { ...position, altitudeM: 0 }, 1);
    expect(layer.root.getObjectByName('bird')!.position.y).toBe(12);
    layer.sync(new Map(), 2, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('keeps a recorded partner beyond the low-tier radius and applies both poses every sync', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(model() as never);
    const layer = new AnimalLayer(); layer.quality = 'smooth';
    const living = new Map([['a', animal('a')], ['b', animal('b')]]);
    const poses = new Map<string, LivePose>([
      ['a', { animal: animal('a'), position: { x: 600, z: 0, heading: 1, moving: true }, seconds: 3, partnerId: 'b', eventId: 'recorded', phase: 'chase' }],
      ['b', { animal: animal('b'), position: { x: 620, z: 0, heading: 1, moving: true }, seconds: 3, partnerId: 'a', eventId: 'recorded', phase: 'chase' }],
    ]);
    layer.sync(living, 0, 'a', { x: 0, z: 0 }, poses);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer);
    layer.sync(living, 1, 'a', { x: 0, z: 0 }, poses);
    expect(layer.root.getObjectByName('a')!.position.x).toBe(600);
    expect(layer.root.getObjectByName('b')!.position.x).toBe(620);
    poses.get('a')!.position.x = 610; poses.get('b')!.position.x = 630;
    layer.sync(living, 2, 'a', { x: 0, z: 0 }, poses);
    expect(layer.root.getObjectByName('a')!.position.x).toBe(610);
    expect(layer.root.getObjectByName('b')!.position.x).toBe(630);
    expect(layer.positionOf('b', 2)!.x).toBe(630); expect(layer.dotIdAt(0)).toBeUndefined();
    layer.sync(new Map(), 3, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('does not allocate obsolete loaded rigs or publish an unplaced model at the world origin', async () => {
    let resolve!: (value: ReturnType<typeof model>) => void;
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(new Promise((yes) => { resolve = yes; }) as never);
    const layer = new AnimalLayer();
    layer.sync(new Map([['old', animal('old')]]), 0, 'old', { x: 0, z: 0 });
    layer.sync(new Map([['new', animal('new', 100)]]), 1, 'new', { x: 100, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    resolve(model()); await ready(layer);
    expect(layer.root.children.map((c) => c.name)).toEqual(['animal-dots', 'crown-limbs', 'contact-shadows']);
    layer.sync(new Map([['new', animal('new', 100)]]), 2, 'new', { x: 100, z: 0 });
    expect(layer.root.getObjectByName('old')).toBeUndefined();
    expect(layer.root.getObjectByName('new')!.position.x).toBe(100);
    expect(layer.root.getObjectByName('new')!.visible).toBe(true);
    layer.sync(new Map(), 3, null, { x: 0, z: 0 });
    expect(layer.root.children.map((c) => c.name)).toEqual(['animal-dots', 'crown-limbs', 'contact-shadows']);
    await ready(layer);
  });
  it('cancels stale live loads on replay entry and resumes live dots at their current interpolated positions', async () => {
    let resolve!: (value: ReturnType<typeof model>) => void;
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(new Promise((yes) => { resolve = yes; }) as never);
    const layer = new AnimalLayer();
    const living = new Map([['a', animal('a')]]);
    layer.sync(living, 0, 'a', { x: 0, z: 0 });
    const pose = { x: 20, z: 5, heading: 1, moving: false };
    layer.syncReplay(animal('recorded'), pose, 5);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    resolve(model()); await ready(layer);
    layer.syncReplay(animal('recorded'), pose, 5);
    expect(layer.root.getObjectByName('a')).toBeUndefined();
    expect(layer.root.getObjectByName('recorded')!.position.x).toBe(20);
    expect(layer.dotIdAt(0)).toBeUndefined();
    const far = { x: 5000, z: 5000 };
    layer.sync(living, 10, null, far);
    living.set('a', animal('a', 100)); layer.sync(living, 20, null, far);
    layer.sync(living, 20 + HOP_DURATION_MS / 2, null, far);
    const dots = layer.root.getObjectByName('animal-dots') as THREE.Points;
    expect(dots.geometry.getAttribute('position').getX(0)).toBe(50);
    expect(layer.dotIdAt(0)).toBe('a'); expect(layer.root.getObjectByName('recorded')).toBeUndefined();
    await ready(layer);
  });
  it('applies a reduced quality budget even when a larger group of pending loads completes', async () => {
    let resolve!: (value: ReturnType<typeof model>) => void;
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(new Promise((yes) => { resolve = yes; }) as never);
    const layer = new AnimalLayer();
    const living = new Map(Array.from({ length: 100 }, (_, i) => [`a${i}`, animal(`a${i}`, i)]));
    layer.quality = 'high'; layer.sync(living, 0, 'a99', { x: 0, z: 0 });
    layer.quality = 'smooth'; layer.sync(living, 1, 'a99', { x: 0, z: 0 });
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    resolve(model()); await ready(layer); layer.sync(living, 2, 'a99', { x: 0, z: 0 });
    expect(layer.root.children.filter((c) => !['animal-dots', 'crown-limbs', 'contact-shadows'].includes(c.name)).length).toBeLessThanOrEqual(2);
    expect(layer.root.getObjectByName('a99')).toBeDefined();
    const loadingDots = layer.root.getObjectByName('animal-dots') as THREE.Points;
    expect(loadingDots.geometry.drawRange.count).toBeGreaterThanOrEqual(98);
    for (let frame = 3; frame < 30; frame++) layer.sync(living, frame, 'a99', { x: 0, z: 0 });
    expect(layer.root.children.filter((c) => !['animal-dots', 'crown-limbs', 'contact-shadows'].includes(c.name))).toHaveLength(24);
    expect(layer.root.getObjectByName('a99')).toBeDefined();
    const dots = layer.root.getObjectByName('animal-dots') as THREE.Points;
    expect(dots.geometry.drawRange.count).toBe(76);
    layer.sync(new Map(), 3, null, { x: 0, z: 0 }); await ready(layer);
  });
  it('discards queued clones after switching into replay and does not hide actors waiting for a rig', async () => {
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(model() as never);
    const layer = new AnimalLayer();
    const living = new Map(Array.from({ length: 40 }, (_, i) => [`a${i}`, animal(`a${i}`, i)]));
    layer.sync(living, 0, 'a39', { x: 0, z: 0 });
    expect((layer.root.getObjectByName('animal-dots') as THREE.Points).geometry.drawRange.count).toBe(40);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    await ready(layer); layer.sync(living, 1, 'a39', { x: 0, z: 0 });
    expect(layer.root.getObjectByName('a39')).toBeDefined();
    const pose = { x: 20, z: 5, heading: 1, moving: false };
    layer.syncReplay(animal('recorded'), pose, 5); await ready(layer);
    layer.syncReplay(animal('recorded'), pose, 5);
    expect(layer.root.children.map((c) => c.name)).toEqual(['animal-dots', 'crown-limbs', 'contact-shadows', 'recorded']);
    layer.sync(new Map(), 2, null, { x: 0, z: 0 });
    expect(layer.root.children.map((c) => c.name)).toEqual(['animal-dots', 'crown-limbs', 'contact-shadows']);
    await ready(layer);
  });
});
