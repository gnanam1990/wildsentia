import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@vana/sim';
import { CommunityLayer } from '../src/communityLayer.js';
import { SceneUpdates } from '../src/sceneUpdates.js';
import type { HistoricHumanFrame } from '../src/humanHistoryReplay.js';

const world = () => createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
  initialAgents: {}, minPopulation: {}, communityProfile: 'household_v1' });
describe('checkpoint-driven modular community scene', () => {
  it('shows only the recorded person in history, hides every person across gaps, and returns to live checkpoints', () => {
    const w = world(), c = w.community!, before = JSON.stringify(c), layer = new CommunityLayer(), ground = () => 4;
    layer.sync(c, ground);
    const id = c.people[0]!.id, saved = c.people[0]!.position;
    expect(layer.positionOf(id, 0, false)).toMatchObject({ x: saved.x, z: saved.z, recorded: false });
    const recorded: HistoricHumanFrame = { personId: id, worldTime: 1800, secondsInWindow: 1800, source: 'recorded',
      sample: { seconds: 0, position: { x: saved.x + 20, z: saved.z + 5, heading: 1 }, alive: true,
        action: 'gather_food', phase: 'travel', taskEventId: 'task-1', moving: true } };
    layer.setHistoricFrame(recorded);
    layer.update(.1, new THREE.Vector3(10_000, 0, 10_000), 'smooth', true, 0);
    expect(layer.showingHistoricFrame).toBe(true);
    expect(layer.positionOf(id, 0, true)).toMatchObject({ x: saved.x + 20, z: saved.z + 5, recorded: true });
    expect(layer.positionOf(c.people[1]!.id, 0, true)).toBeNull();
    const humans = layer.root.getObjectByName('checkpoint-humans')!;
    const markers = humans.getObjectByName('saved-person-location-markers') as THREE.Points;
    expect(humans.visible).toBe(true); expect(markers.geometry.drawRange.count).toBe(1);
    expect(markers.geometry.getAttribute('position').getX(0)).toBeCloseTo(saved.x + 20);
    const recordedNotice = layer.playbackNotice(0, true);
    expect(recordedNotice).toContain('hourly person movement');
    layer.setHistoricFrame({ ...recorded, worldTime: 1801 });
    expect(layer.playbackNotice(0, true)).toBe(recordedNotice); // role=status must not announce every frame.
    layer.setHistoricFrame({ ...recorded, worldTime: 5400, secondsInWindow: null, source: 'gap', sample: null });
    layer.update(.1, new THREE.Vector3(), 'smooth', false, 0);
    expect(humans.visible).toBe(false); expect(layer.positionOf(id, 0, false)).toBeNull();
    expect(layer.playbackNotice(0, false)).toContain('saved person position');
    layer.setHistoricFrame({ ...recorded, worldTime: null, secondsInWindow: null, source: 'unavailable', sample: null });
    layer.update(.1, new THREE.Vector3(), 'smooth', false, 0);
    expect(humans.visible).toBe(false); expect(layer.playbackNotice(0, false)).toContain('No saved movement available');
    layer.setHistoricFrame({ ...recorded, personId: 'person_no_longer_retained' });
    layer.update(.1, new THREE.Vector3(), 'smooth', false, 0);
    expect(humans.visible).toBe(false); expect(layer.playbackNotice(0, false)).toContain('absent from the current scene');
    layer.setHistoricFrame(null); layer.update(.1, new THREE.Vector3(10_000, 0, 10_000), 'smooth', true, 0);
    expect(humans.visible).toBe(true); expect(layer.positionOf(id, 0, true)).toMatchObject({ x: saved.x, z: saved.z, recorded: false });
    expect(markers.geometry.drawRange.count).toBe(c.people.length);
    expect(JSON.stringify(c)).toBe(before); layer.dispose();
  });
  it('projects retained frame and covering into bounded wear cues without changing saved material state', () => {
    const w = world(); w.step(24); const c = w.community!, layer = new CommunityLayer();
    const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
    const roof = layer.root.getObjectByName('home-roof') as THREE.InstancedMesh;
    const posts = layer.root.getObjectByName('home-posts') as THREE.InstancedMesh;
    c.building.materials = { timberKg: 96, fibreKg: 72 }; layer.sync(c, () => 0);
    roof.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix); expect(scale.x).toBeCloseTo(6);
    c.building.materials = { timberKg: 24, fibreKg: 36 }; const before = JSON.stringify(c);
    layer.sync(c, () => 0);
    roof.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix); expect(scale.x).toBeCloseTo(3);
    posts.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix); expect(scale.x).toBeCloseTo(.08);
    expect(JSON.stringify(c)).toBe(before);
    c.building.materials = { timberKg: 96, fibreKg: 72 }; layer.sync(c, () => 0);
    roof.getMatrixAt(0, matrix); scale.setFromMatrixScale(matrix); expect(scale.x).toBeCloseTo(6);
    layer.dispose();
  });
  it('shows only completed construction stages, places four saved markers, hides during historical replay and disposes owned resources', () => {
    const w = world(), layer = new CommunityLayer(), ground = () => 4;
    expect(layer.root.visible).toBe(false); layer.sync(w.community, ground);
    const beam = layer.root.getObjectByName('home-beams')!, wall = layer.root.getObjectByName('home-walls')!, roof = layer.root.getObjectByName('home-roof')!;
    expect([beam.visible, wall.visible, roof.visible]).toEqual([false, false, false]);
    const before = JSON.stringify(w.community);
    const markers = layer.root.getObjectByName('saved-person-location-markers') as THREE.Points;
    expect(markers.geometry.drawRange.count).toBe(4); expect(markers.geometry.getAttribute('position').getY(0)).toBeCloseTo(5.65);
    expect(JSON.stringify(w.community)).toBe(before);
    for (const [stage, visible] of [ ['frame', [true, false, false]], ['walls', [true, true, false]], ['roof', [true, true, true]], ['occupied', [true, true, true]]] as const) {
      const state = structuredClone(w.community!); state.building.stage = stage; layer.sync(state, ground);
      expect([beam.visible, wall.visible, roof.visible]).toEqual(visible);
    }
    const debris = layer.root.getObjectByName('illustrative-collapse-debris') as THREE.InstancedMesh;
    const collapsed = structuredClone(w.community!);
    collapsed.version = 8; collapsed.building.stage = 'site';
    collapsed.building.maintenance = { repairsCompleted: 0, lastRepairAt: null, collapses: 1,
      lastCollapseAt: 3600, lastCollapseEventId: 'collapse_1', rebuildsCompleted: 0 };
    layer.sync(collapsed, ground); expect(debris.visible).toBe(true);
    expect(roof.visible).toBe(false);
    collapsed.building.maintenance.rebuildsCompleted = 1;
    layer.sync(collapsed, ground); expect(debris.visible).toBe(false);
    layer.setReplay(true); expect(layer.root.visible).toBe(false);
    expect(layer.positionOf(w.community!.people[0]!.id, 0, false)).toMatchObject({ ...w.community!.people[0]!.position, recorded: false });
    layer.setReplay(false); expect(layer.root.visible).toBe(true);
    layer.sync(null, ground); layer.setReplay(false); expect(layer.root.visible).toBe(false);
    expect(layer.positionOf(w.community!.people[0]!.id, 0, false)).toBeNull();
    const dispose = vi.spyOn(markers.geometry, 'dispose'); layer.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(layer.root.children).toHaveLength(0);
  });
  it('rejects communities from another checkpoint or absent patch, instead of mixing environment generations', () => {
    const w = world(), c = w.community!, patch = w.patches[c.patchId]!;
    const frame = { type: 'scene', protocol: 1, checkpointId: 'saved', frame: null, animals: [],
      world: { worldTime: 0, nextEventSequence: 1, worldHoursPerRealHour: 12, population: {}, formatted: '', season: 'wet' },
      environment: { community: c, carcasses: [], patches: [{ id: patch.id, x: patch.x, y: patch.y, habitat: patch.habitat,
        grass: patch.plant.grass, browse: patch.plant.browse, water: patch.waterVolume, elevation: patch.elevation, canopyCover: patch.canopyCover }] } };
    const updates = () => new SceneUpdates({ prepare: async () => null, commit() {}, discard() {}, status() {} });
    expect(updates().receive(frame, 0)).toBe(true);
    const future = structuredClone(frame); future.environment.community.updatedAt = 1;
    expect(updates().receive(future, 0)).toBe(false);
    const missing = structuredClone(frame); missing.environment.patches[0]!.id++;
    expect(updates().receive(missing, 0)).toBe(false);
  });
});
