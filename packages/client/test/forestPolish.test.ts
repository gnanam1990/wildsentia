import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CONGO_GRID, ISLAND_GRID, treeAnchorForPatch } from '@vana/shared';
import { followDistanceFor } from '../src/camera.js';
import { planCongoPatch } from '../src/congoPlants.js';
import { ContactShadows, standingSoles } from '../src/contactShadows.js';
import { DrinkingRipple } from '../src/drinkingRipple.js';
import type { PatchView } from '../src/terrain.js';
import { setWorldGrid } from '../src/worldGrid.js';

/** The shipped model's geometry, rig and clips, without its textures. */
async function shipped(file: string) {
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

/** Stands the model's rest pose on the floor at y = 0, as the animal layer stands it on the ground. */
function standOnFloor(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  scene.position.y -= new THREE.Box3().setFromObject(scene, true).min.y;
  scene.updateMatrixWorld(true);
}

function pose(scene: THREE.Object3D, clip: THREE.AnimationClip, phase: number): THREE.SkinnedMesh {
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(clip).play();
  mixer.setTime(clip.duration * phase);
  scene.updateMatrixWorld(true);
  const body = scene.getObjectByName('Body') as THREE.SkinnedMesh;
  body.skeleton.update();
  return body;
}

afterEach(() => setWorldGrid(ISLAND_GRID));

describe('follow camera framing', () => {
  it('frames the forest elephant as the island elephant and duikers a little nearer, others unchanged', () => {
    expect(followDistanceFor('forest_elephant', 2.6)).toBe(followDistanceFor('elephant', 2.6));
    expect(followDistanceFor('forest_elephant', 2.6)).toBeCloseTo(13);
    expect(followDistanceFor('peters_duiker', 0.62)).toBeCloseTo(0.62 * 6.5);
    expect(followDistanceFor('blue_duiker', 0.45)).toBeCloseTo(0.45 * 6.5);
    expect(followDistanceFor('water_chevrotain', 0.38)).toBeCloseTo(0.38 * 9);
    expect(followDistanceFor('sitatunga', 1.35)).toBeCloseTo(1.35 * 9);
    expect(followDistanceFor('forest_buffalo', 1.4)).toBeCloseTo(1.4 * 9);
  });
});

describe('foot contact shadows', () => {
  it.each([
    ['/assets/animals/ForestElephant.glb'],
    ['/assets/animals/BlueDuiker.glb'],
    ['/assets/animals/AfricanLeopard.glb'],
    ['/assets/animals/RedRiverHog.glb'],
  ])('finds one sole under each of the four feet of %s, on the floor in the standing pose', async (file) => {
    const { scene } = await shipped(file);
    standOnFloor(scene);
    const soles = standingSoles(scene);
    expect(soles).toHaveLength(4);
    const centre = new THREE.Box3().setFromObject(scene, true).getCenter(new THREE.Vector3());
    const quadrants = new Set<string>();
    for (const sole of soles) {
      const at = sole.bone.localToWorld(sole.point.clone());
      expect(at.y).toBeCloseTo(0, 5);
      quadrants.add(`${Math.sign(at.x - centre.x)}:${Math.sign(at.z - centre.z)}`);
    }
    // Two feet each side, two at each end: none of the four points share a corner.
    expect(quadrants.size).toBe(4);
  });

  it('tilts a patch to the slope it lies on and gives a foot its own narrow size', () => {
    const shadows = new ContactShadows(4), matrix = new THREE.Matrix4();
    shadows.update([
      { x: 0, y: 0, z: 0, lengthM: 1, heading: 0, slopeX: 0.5, slopeZ: 0 },
      { x: 2, y: 0, z: 0, lengthM: 0.135, widthM: 0.1, heading: 0 },
    ]);
    expect(shadows.mesh.count).toBe(2);
    shadows.mesh.getMatrixAt(0, matrix);
    // The plane's own normal (+z before it is laid flat) ends up along the ground's normal.
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
    expect(normal.dot(new THREE.Vector3(-0.5, 1, 0).normalize())).toBeCloseTo(1, 5);
    shadows.mesh.getMatrixAt(1, matrix);
    const scale = new THREE.Vector3();
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0.1);
    expect(scale.y).toBeCloseTo(0.135);
  });
});

describe('forest elephant drinking ripple', () => {
  it('rings the water where the shipped trunk touches it, only while the trunk is down', async () => {
    const { scene, animations } = await shipped('/assets/animals/ForestElephant.glb');
    standOnFloor(scene);
    const drinking = animations.find((clip) => clip.name === 'Drinking')!;
    expect(drinking).toBeDefined();
    const ground = () => 0;

    // Where the trunk tip is mid-drink, a pool lies ahead of the elephant.
    const ripple = new DrinkingRipple();
    let body = pose(scene, drinking, 0.38);
    const probe = new DrinkingRipple();
    const pool = { x: 0, z: 0, radius: 1.5, seed: 3 };
    // Centre the pool on the tip by asking where a ripple would be for a pool under the whole model.
    const box = new THREE.Box3().setFromObject(scene, true), wide = { x: (box.min.x + box.max.x) / 2,
      z: (box.min.z + box.max.z) / 2, radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z), seed: 3 };
    probe.update(body, 0.38, [wide], ground);
    expect(probe.mesh.visible).toBe(true);
    pool.x = probe.mesh.position.x; pool.z = probe.mesh.position.z;
    // The trunk reaches the water: the ring sits within a few centimetres of the floor it was lowered to.
    expect(probe.mesh.position.y).toBeLessThan(0.12);

    ripple.update(body, 0.38, [pool], ground);
    expect(ripple.mesh.visible).toBe(true);
    expect(ripple.mesh.material.opacity).toBeGreaterThan(0);
    const early = ripple.mesh.scale.x;
    body = pose(scene, drinking, 0.46);
    ripple.update(body, 0.46, [pool], ground);
    expect(ripple.mesh.visible).toBe(true);
    expect(ripple.mesh.scale.x).toBeGreaterThan(early);

    // Head up, or nothing to drink from: no ring.
    body = pose(scene, drinking, 0.1);
    ripple.update(body, 0.1, [pool], ground);
    expect(ripple.mesh.visible).toBe(false);
    body = pose(scene, drinking, 0.38);
    ripple.update(body, 0.38, [], ground);
    expect(ripple.mesh.visible).toBe(false);
    ripple.update(body, 0.38, [{ ...pool, x: pool.x + 40 }], ground);
    expect(ripple.mesh.visible).toBe(false);
  });
});

describe('Congo floor plants', () => {
  const patch = (id: number, habitat: string): PatchView => ({ id, x: id % 160, y: Math.floor(id / 160), habitat, elevation: 0.4,
    canopyCover: 0.9, grass: 800, browse: 4000, water: 300, congoSeed: 7, surface: 'land' } as PatchView);

  it('grows seedlings in small beds with bare litter between them', () => {
    setWorldGrid(CONGO_GRID);
    const plants = planCongoPatch(patch(12_880, 'terra_firme'), 7).filter((p) => p.kind === 'groundcover' || p.kind === 'herb');
    expect(plants.length).toBeGreaterThan(20);
    // Each seedling has a neighbour of its own kind within its bed (2 m), far closer than an even scatter would give.
    let near = 0;
    for (const p of plants) {
      if (plants.some((q) => q !== p && q.kind === p.kind && Math.hypot(q.x - p.x, q.z - p.z) <= 4)) near++;
    }
    expect(near / plants.length).toBeGreaterThan(0.8);
  });

  it('varies crown width on ordinary trees but leaves the climbing tree at its measured size', () => {
    setWorldGrid(CONGO_GRID);
    for (const id of [12_880, 12_881, 13_054]) {
      const view = patch(id, 'terra_firme'), anchor = treeAnchorForPatch(CONGO_GRID, view);
      const plants = planCongoPatch(view, 7);
      for (const p of plants) {
        const tree = p.kind === 'emergent' || p.kind === 'canopy' || p.kind === 'midstory';
        const isAnchor = anchor !== null && p.kind === 'canopy' && p.x === anchor.x && p.z === anchor.z;
        if (!tree || isAnchor) expect(p.spread).toBeUndefined();
        else { expect(p.spread).toBeGreaterThanOrEqual(0.82); expect(p.spread).toBeLessThan(1.2); }
      }
    }
  });
});
