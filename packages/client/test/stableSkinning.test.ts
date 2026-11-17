import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { stabilizeSkinnedMaterial, stabilizeSkinning, writeMeshRelativeBones } from '../src/stableSkinning.js';

function skinnedAt(x: number, z: number): { root: THREE.Group; mesh: THREE.SkinnedMesh } {
  const bone = new THREE.Bone(), child = new THREE.Bone(); child.position.set(0, 0.4, 0.1); bone.add(child);
  const geometry = new THREE.BoxGeometry(0.4, 0.4, 0.8);
  const count = geometry.attributes.position!.count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0).map((_, i) => (i % 4 === 1 ? 1 : 0)), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(count * 4).fill(0).map((_, i) => (i % 4 === 0 ? 0.6 : i % 4 === 1 ? 0.4 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone, child]));
  const root = new THREE.Group(); root.add(mesh); root.position.set(x, 130, z); root.rotation.y = 0.7;
  child.rotation.x = 0.3;
  root.updateMatrixWorld(true);
  return { root, mesh };
}

describe('stable skinning far from the origin', () => {
  it('hands the GPU bones relative to the mesh: small numbers, the same body', () => {
    const { mesh } = skinnedAt(31_000, 27_500);
    writeMeshRelativeBones(mesh.skeleton, mesh.matrixWorld);
    const relative = new THREE.Matrix4(), expected = new THREE.Matrix4(), toMesh = mesh.matrixWorld.clone().invert();
    for (let i = 0; i < 2; i++) {
      relative.fromArray(mesh.skeleton.boneMatrices, i * 16);
      // In 64-bit: the mesh's inverse times the bone's world matrix times its inverse bind.
      expected.multiplyMatrices(mesh.skeleton.bones[i]!.matrixWorld, mesh.skeleton.boneInverses[i]!).premultiply(toMesh);
      // Stored as 32-bit floats of body-sized numbers: accurate to well under a micrometre.
      for (let k = 0; k < 16; k++) expect(Math.abs(relative.elements[k]! - expected.elements[k]!)).toBeLessThan(1e-6);
      expect(Math.abs(relative.elements[12]!) + Math.abs(relative.elements[14]!)).toBeLessThan(5); // not 30 km
    }
  });
  it('drops the shader\'s subtraction of the mesh\'s far position, once, after any earlier hook', () => {
    const material = new THREE.MeshStandardMaterial(); const calls: string[] = [];
    material.onBeforeCompile = () => { calls.push('own'); };
    stabilizeSkinnedMaterial(material); stabilizeSkinnedMaterial(material);
    const shader = { vertexShader: 'a\n#include <skinning_vertex>\n#include <skinnormal_vertex>\nb' } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(calls).toEqual(['own']);
    expect(shader.vertexShader).toContain('transformed = skinned.xyz;');
    expect(shader.vertexShader).toContain('skinMatrix = skinMatrix * bindMatrix;');
    expect(shader.vertexShader).not.toContain('bindMatrixInverse *');
    expect(material.customProgramCacheKey()).toMatch(/\|stableSkin$/);
  });
  it('patches a skeleton that drives one mesh, with a matching shadow material, and leaves a shared one alone', () => {
    const { root, mesh } = skinnedAt(25_000, 25_000);
    expect(stabilizeSkinning(root)).toBe(1);
    expect(mesh.customDepthMaterial?.userData.stableSkinning).toBe(true);
    mesh.skeleton.update();
    expect(Math.abs(mesh.skeleton.boneMatrices[12]!)).toBeLessThan(5);
    const shared = skinnedAt(0, 0), twin = new THREE.SkinnedMesh(shared.mesh.geometry, new THREE.MeshStandardMaterial());
    shared.root.add(twin); twin.bind(shared.mesh.skeleton);
    expect(stabilizeSkinning(shared.root)).toBe(0);
  });
});
