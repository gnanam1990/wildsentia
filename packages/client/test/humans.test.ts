import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createWorld } from '@vana/sim';
import { fileURLToPath } from 'node:url';
import { HumanLayer, humanAgeScale, humanAppearance, humanPose, tintHumanScene, type HumanTemplate, spreadCrowded } from '../src/humans.js';
import type { Person } from '@vana/shared';
import type { HumanPlaybackPose } from '../src/communityPlayback.js';

const people = (): Person[] => createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: {}, minPopulation: {}, communityProfile: 'household_v1' }).community!.people.map((p, i) => ({ ...p, appearanceSeed: i,
    position: { x: i * 2, z: 0, heading: .2 } }));
function template(): HumanTemplate {
  const scene = new THREE.Group(), bone = new THREE.Bone(); bone.name = 'testBone'; scene.add(bone);
  const geometry = new THREE.BoxGeometry(.2, 1, .2), count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ name: 'MI_Peasant' }));
  scene.add(mesh); mesh.bind(new THREE.Skeleton([bone]));
  return { scene, animations: ['Idle_Loop', 'Walk_Loop', 'Fixing_Kneeling', 'PickUp_Table', 'Interact', 'Death01'].map(name => new THREE.AnimationClip(name, 1,
    [new THREE.QuaternionKeyframeTrack('testBone.quaternion', [0, .5, 1], [0, 0, 0, 1, 0, 0, .3, Math.sqrt(.91), 0, 0, 0, 1])])) };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const markers = (layer: HumanLayer) => layer.root.getObjectByName('saved-person-location-markers') as THREE.Points;
const rigs = (layer: HumanLayer) => layer.root.children.filter(c => c.name.startsWith('person_'));
describe('checkpoint human character layer', () => {
  it('holds a static recorded seek pose with reduced motion, isolates its rig and restores checkpoints', async () => {
    const p = people(), before = JSON.stringify(p), layer = new HumanLayer(async () => template());
    layer.sync(p, () => 4);
    const id = p[0]!.id, pose: HumanPlaybackPose = { position: { x: 20, z: 5, heading: 1 }, alive: true,
      task: { kind: 'gather_food', phase: 'travel' }, moving: true, animationSeconds: 120 };
    const poses = new Map([[id, pose]]);
    layer.update(.1, new THREE.Vector3(20, 4, 5), 'high', true, true, poses, id, id, true);
    await flush(); layer.update(.1, new THREE.Vector3(20, 4, 5), 'high', true, true, poses, id, id, true);
    expect(rigs(layer)).toHaveLength(1); expect(rigs(layer)[0]!.name).toBe(id);
    expect(rigs(layer)[0]!.position.toArray()).toEqual([20, 4.03, 5]);
    expect(markers(layer).geometry.drawRange.count).toBe(0);
    layer.update(.1, new THREE.Vector3(500, 0, 0), 'high', true);
    expect(rigs(layer)).toHaveLength(0); expect(markers(layer).geometry.drawRange.count).toBe(p.length);
    expect(markers(layer).geometry.getAttribute('position').getX(0)).toBe(p[0]!.position.x);
    expect(JSON.stringify(p)).toBe(before); layer.dispose();
  });
  it('renders dependent children with a smaller marker and rig while retaining adult appearance and saved positions', async () => {
    const p = people().slice(0, 2), child = { ...p[1]!, id: 'person_0005', ageDays: 0, massKg: 3 };
    p[1] = child;
    expect(humanAgeScale(child.ageDays)).toBe(.42);
    expect(humanAgeScale(6 * 360)).toBeCloseTo(.7);
    expect(humanAgeScale(18 * 360)).toBe(1);
    const layer = new HumanLayer(async () => template()); layer.sync(p, () => 2);
    const childMarkers = layer.root.getObjectByName('saved-child-location-markers') as THREE.Points;
    expect(markers(layer).geometry.drawRange.count).toBe(1);
    expect(childMarkers.geometry.drawRange.count).toBe(1);
    expect((childMarkers.material as THREE.PointsMaterial).size).toBeLessThan((markers(layer).material as THREE.PointsMaterial).size);
    expect(layer.positionOf(child.id)).toMatchObject({ x: child.position.x, z: child.position.z, scale: .42 });
    layer.update(.1, new THREE.Vector3(), 'high', false); await flush(); layer.update(.1, new THREE.Vector3(), 'high', false);
    const childRig = layer.root.getObjectByName(child.id)!;
    expect(childRig.children[0]!.scale.x).toBeCloseTo(humanAppearance(child.appearanceSeed).scale * .42);
    expect(child.position.x).toBe(2);
    expect(humanPose({ alive: true, task: { kind: 'care_child', phase: 'work' } as Person['task'] })).toEqual({ clip: 'Interact', lying: false });
    layer.dispose();
  });
  it('drives the actual rig and animation clock from a recorded pose without showing the checkpoint death early', async () => {
    const p = people().slice(0, 1); p[0]!.alive = false;
    const before = JSON.stringify(p), layer = new HumanLayer(async () => template()); layer.sync(p, () => 4);
    const pose: HumanPlaybackPose = { position: { x: 30, z: 20, heading: 1 }, alive: true,
      task: { kind: 'gather_food', phase: 'travel' }, moving: true, animationSeconds: .3 };
    const poses = new Map([[p[0]!.id, pose]]);
    layer.update(.1, new THREE.Vector3(), 'high', false, true, poses); await flush();
    layer.update(.1, new THREE.Vector3(), 'high', false, true, poses);
    const rig = rigs(layer)[0]!, bone = rig.getObjectByName('testBone')!, q = bone.quaternion.toArray();
    expect(rig.position.toArray()).toEqual([30, 4.03, 20]); expect(rig.rotation.y).toBe(1);
    expect(layer.positionOf(p[0]!.id, poses)).toMatchObject({ x: 30, y: 4.03, z: 20, heading: 1, recorded: true, alive: true });
    expect(layer.positionOf(p[0]!.id)).toMatchObject({ x: 0, y: 4.09, z: 0, recorded: false, alive: false });
    expect(layer.positionOf('absent')).toBeNull();
    layer.update(.1, new THREE.Vector3(), 'high', false, true, poses); expect(bone.quaternion.toArray()).toEqual(q);
    pose.animationSeconds = .6; layer.update(.1, new THREE.Vector3(), 'high', false, true, poses); expect(bone.quaternion.toArray()).not.toEqual(q);
    layer.update(.1, new THREE.Vector3(), 'high', true, true, poses); expect(rig.position.toArray()).toEqual([0, 4.09, 0]);
    expect(JSON.stringify(p)).toBe(before); layer.dispose();
  });
  it('applies the gallery palette once even when multiple clothing meshes share a material', () => {
    const scene = new THREE.Group(), cloth = new THREE.MeshStandardMaterial({ name: 'MI_Peasant' });
    const geometry = new THREE.BoxGeometry();
    scene.add(new THREE.Mesh(geometry, cloth), new THREE.Mesh(geometry, cloth));
    tintHumanScene(scene, 0); expect(cloth.color.toArray()).toEqual(new THREE.Color(humanAppearance(0).cloth).toArray());
    cloth.dispose(); geometry.dispose();
  });
  it('loads no distant assets, shares two templates, bounds detailed rigs and keeps all remaining people as markers', async () => {
    const load = vi.fn(async () => template()), layer = new HumanLayer(load), p = people(); layer.sync(p, () => 0);
    layer.update(.1, new THREE.Vector3(500, 0, 0), 'high', false); await flush(); expect(load).not.toHaveBeenCalled();
    layer.update(.1, new THREE.Vector3(), 'high', false); layer.update(.1, new THREE.Vector3(), 'high', false);
    await flush(); expect(load).toHaveBeenCalledTimes(2);
    layer.update(.1, new THREE.Vector3(), 'high', false); expect(rigs(layer)).toHaveLength(4); expect(markers(layer).geometry.drawRange.count).toBe(0);
    layer.update(.1, new THREE.Vector3(), 'smooth', false); expect(rigs(layer)).toHaveLength(2); expect(markers(layer).geometry.drawRange.count).toBe(2);
    layer.update(.1, new THREE.Vector3(), 'smooth', false, true, new Map(), p[3]!.id);
    expect(rigs(layer)).toHaveLength(2); expect(layer.root.getObjectByName(p[3]!.id)).toBeDefined();
    layer.update(.1, new THREE.Vector3(), 'high', false, false); expect(rigs(layer)).toHaveLength(0);
    expect(markers(layer).geometry.drawRange.count).toBe(4); layer.dispose();
  });
  it('holds saved coordinates and heading while independently animating cloned bones; reduced motion freezes the pose', async () => {
    const t = template(), layer = new HumanLayer(async () => t), p = people().slice(0, 2);
    p[1]!.appearanceSeed = 0; p[0]!.task = { kind: 'gather_food', phase: 'travel', destination: { x: 100, z: 100, heading: 0 }, remainingSeconds: 50, startedAt: 0, eventId: 'event' };
    const before = JSON.stringify(p); layer.sync(p, () => 4); layer.update(.1, new THREE.Vector3(), 'high', false); await flush();
    layer.update(.1, new THREE.Vector3(), 'high', false);
    const [a, b] = rigs(layer), boneA = a!.getObjectByName('testBone')!, boneB = b!.getObjectByName('testBone')!;
    expect(boneA).not.toBe(boneB); expect(boneA).not.toBe(t.scene.getObjectByName('testBone'));
    for (let i = 0; i < 20; i++) layer.update(.1, new THREE.Vector3(), 'high', false);
    expect(a!.position.toArray()).toEqual([0, 4.03, 0]); expect(a!.rotation.y).toBe(.2); expect(JSON.stringify(p)).toBe(before);
    layer.update(.1, new THREE.Vector3(), 'high', true); const reduced = boneA.quaternion.toArray();
    layer.update(.1, new THREE.Vector3(), 'high', true); expect(boneA.quaternion.toArray()).toEqual(reduced);
    const saved = structuredClone(p); saved[0]!.position.x = 25; layer.sync(saved, () => 5);
    layer.update(.1, new THREE.Vector3(), 'high', true); expect(a!.position.x).toBe(25); expect(a!.position.y).toBeCloseTo(5.03);
    layer.dispose();
  });
  it('uses latest checkpoint after delayed load, removes absent people and discards templates that finish after disposal', async () => {
    let resolve!: (value: HumanTemplate) => void;
    const layer = new HumanLayer(() => new Promise(r => { resolve = r; })), p = people().slice(0, 1), t = template();
    layer.sync(p, () => 0); layer.update(.1, new THREE.Vector3(), 'high', false); await flush();
    p[0]!.position.x = 40; layer.sync(p, () => 0); resolve(t); await flush(); layer.update(.1, new THREE.Vector3(), 'high', false);
    expect(rigs(layer)[0]!.position.x).toBe(40); layer.sync([], () => 0); expect(rigs(layer)).toHaveLength(0); layer.dispose();
    let late!: (value: HumanTemplate) => void; const abandoned = new HumanLayer(() => new Promise(r => { late = r; }));
    abandoned.sync(people().slice(0, 1), () => 0); abandoned.update(.1, new THREE.Vector3(), 'high', false); await flush(); abandoned.dispose();
    const unused = template(), mesh = unused.scene.children.find(c => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const disposed = vi.spyOn(mesh.geometry, 'dispose'); late(unused); await flush(); expect(disposed).toHaveBeenCalledOnce(); expect(abandoned.root.children).toHaveLength(0);
  });
  it('keeps failed or clip-incomplete models as markers with no per-frame retry or bind-pose fallback', async () => {
    const load = vi.fn(async () => { throw new Error('offline'); }), layer = new HumanLayer(load);
    layer.sync(people().slice(0, 1), () => 0); layer.update(.1, new THREE.Vector3(), 'high', false); await flush();
    for (let i = 0; i < 30; i++) layer.update(.1, new THREE.Vector3(), 'high', false);
    expect(load).toHaveBeenCalledOnce(); expect(layer.status).toBe('failed'); expect(rigs(layer)).toHaveLength(0); expect(markers(layer).geometry.drawRange.count).toBe(1); layer.dispose();
    const noClips = new HumanLayer(async () => ({ ...template(), animations: [] })); noClips.sync(people().slice(0, 1), () => 0);
    noClips.update(.1, new THREE.Vector3(), 'high', false); await flush(); noClips.update(.1, new THREE.Vector3(), 'high', false);
    expect(rigs(noClips)).toHaveLength(0); expect(markers(noClips).geometry.drawRange.count).toBe(1); noClips.dispose();
  });
  it('rebuilds same-id appearance across world changes and disposes shared geometry/textures only at template release', async () => {
    const t = template(), layer = new HumanLayer(async () => t), p = people().slice(0, 2); p[1]!.appearanceSeed = 0;
    const mesh = t.scene.children.find(c => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const geometry = vi.spyOn(mesh.geometry, 'dispose'), material = vi.spyOn(mesh.material as THREE.Material, 'dispose');
    layer.sync(p, () => 0); layer.update(.1, new THREE.Vector3(), 'high', false); await flush(); layer.update(.1, new THREE.Vector3(), 'high', false);
    const old = rigs(layer)[0]!; p[0]!.appearanceSeed = 24; layer.sync(p, () => 0); layer.update(.1, new THREE.Vector3(), 'high', false);
    expect(layer.root.getObjectByName(p[0]!.id)).not.toBe(old); expect(geometry).not.toHaveBeenCalled();
    layer.update(.1, new THREE.Vector3(500, 0, 0), 'high', false); expect(geometry).not.toHaveBeenCalled();
    layer.dispose(); layer.dispose(); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce();
  });
  it('keeps sleeping or dead bodies in a held lying pose until recorded decomposition removes the body', async () => {
    const p = people().slice(0, 1); p[0]!.alive = false; const layer = new HumanLayer(async () => template());
    layer.sync(p, () => 0); layer.update(.1, new THREE.Vector3(), 'high', false); await flush(); layer.update(.1, new THREE.Vector3(), 'high', false);
    const rig = rigs(layer)[0]!, bone = rig.getObjectByName('testBone')!, q = bone.quaternion.toArray();
    layer.update(.1, new THREE.Vector3(), 'high', false); expect(bone.quaternion.toArray()).toEqual(q); expect(rig.position.y).toBe(.09);
    p[0]!.massKg = 0; layer.sync(p, () => 0); expect(rigs(layer)).toHaveLength(0); expect(markers(layer).geometry.drawRange.count).toBe(0); layer.dispose();
    expect(humanPose({ alive: true, task: { kind: 'sleep', phase: 'work' } as Person['task'] })).toEqual({ clip: 'Death01', lying: true });
  });
  it('shows task tools only for authoritative work poses in live and recorded views', async () => {
    const p = people().slice(0, 1), id = p[0]!.id;
    const layer = new HumanLayer(async () => template()); layer.sync(p, () => 4);
    layer.update(.1, new THREE.Vector3(), 'high', false); await flush();
    const task = (kind: NonNullable<Person['task']>['kind'], phase: 'travel' | 'work'): HumanPlaybackPose => ({
      position: { x: 12, z: 8, heading: .7 }, alive: true, task: { kind, phase }, moving: phase === 'travel', animationSeconds: 90,
    });
    const check = (kind: NonNullable<Person['task']>['kind'], phase: 'travel' | 'work', expected: string | null) => {
      layer.update(.1, new THREE.Vector3(12, 4, 8), 'high', false, true, new Map([[id, task(kind, phase)]]), id, id, true);
      const rig = layer.root.getObjectByName(id)!;
      expect(rig.position.toArray()).toEqual([12, 4.03, 8]); expect(rig.rotation.y).toBe(.7);
      for (const name of ['task-prop-fish', 'task-prop-hunt', 'task-prop-build'])
        expect(rig.getObjectByName(name)!.visible, `${kind}/${phase}: ${name}`).toBe(name === expected);
    };
    check('fish', 'work', 'task-prop-fish');
    check('hunt', 'work', 'task-prop-hunt');
    check('build', 'work', 'task-prop-build');
    check('repair', 'work', 'task-prop-build');
    check('hunt', 'travel', null);
    check('rest', 'work', null);
    p[0]!.task = { kind: 'fish', phase: 'work', destination: p[0]!.position, remainingSeconds: 20,
      startedAt: 0, eventId: 'recorded-task' };
    const before = JSON.stringify(p);
    layer.sync(p, () => 4);
    layer.update(.1, new THREE.Vector3(), 'high', true);
    const rig = layer.root.getObjectByName(id)!;
    expect(rig.getObjectByName('task-prop-fish')!.visible).toBe(true);
    expect(rig.getObjectByName('task-prop-hunt')!.visible).toBe(false);
    const rod = rig.getObjectByName('fishing-rod') as THREE.Mesh;
    const dispose = vi.spyOn(rod.geometry, 'dispose');
    layer.dispose(); expect(dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(p)).toBe(before);
  });
  it('selects stable presentation variants and covers every recorded task without assuming successful outcomes', () => {
    expect(humanAppearance(123456)).toEqual(humanAppearance(123456)); expect(humanAppearance(123456).scale).toBeGreaterThan(.9);
    const tasks = ['gather_food', 'collect_water', 'gather_timber', 'gather_fibre', 'deliver', 'eat', 'drink', 'sleep', 'build', 'rest', 'fish', 'hunt', 'cook', 'repair', 'seek_resources'] as const;
    for (const kind of tasks) {
      expect(humanPose({ alive: true, task: { kind, phase: 'travel' } as Person['task'] }).clip).toBe('Walk_Loop');
      expect(humanPose({ alive: true, task: { kind, phase: 'work' } as Person['task'] }).clip).toBeTruthy();
    }
  });
});

describe('people sharing one spot', () => {
  const at = (id: string, x: number, z: number) => ({ id, position: { x, z, heading: 1 } });
  it('draws a household resting at home in a ring instead of inside one another', () => {
    const home = [at('person_0003', 930, 2730), at('person_0001', 930, 2730), at('person_0002', 930, 2730), at('person_0004', 930, 2730)];
    const drawn = spreadCrowded(home);
    expect(drawn.map(p => p.id)).toEqual(home.map(p => p.id)); // Order kept.
    for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++)
      expect(Math.hypot(drawn[i]!.position.x - drawn[j]!.position.x, drawn[i]!.position.z - drawn[j]!.position.z)).toBeGreaterThan(1);
    for (const p of drawn) expect(Math.hypot(p.position.x - 930, p.position.z - 2730)).toBeCloseTo(0.8);
    expect(spreadCrowded([...home].reverse())).toEqual([...drawn].reverse()); // Same ring whatever the order.
  });
  it('leaves people standing apart exactly where they were recorded', () => {
    const apart = [at('a', 0, 0), at('b', 5, 0)];
    expect(spreadCrowded(apart)).toEqual(apart);
  });
});
