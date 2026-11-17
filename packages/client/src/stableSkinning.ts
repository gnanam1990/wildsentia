import * as THREE from 'three';

/**
 * Skinned animals far from the world's origin shimmered. The Congo is 48 km across, so an animal
 * stands some 25-40 km from (0, 0). three.js hands each bone's world matrix to the GPU, which
 * works in 32-bit floats: at 30 km those carry about 4 mm, and the shader then subtracts the
 * mesh's own 30 km position back out. What is left of the body is accurate to 6-10 mm, and that
 * error changes every frame as the animal moves: a small animal seen close up vibrates.
 *
 * Here each bone's matrix is made relative to the mesh in JavaScript (64-bit), so the numbers the
 * GPU sees are a body's size, not the world's, and the shader no longer subtracts the position.
 * The shadow pass gets the same treatment. Picking (raycasts) and bounds use the bones' world
 * matrices in JavaScript, untouched.
 */

const STABLE_SKINNING_VERTEX = THREE.ShaderChunk.skinning_vertex.replace(
  'transformed = ( bindMatrixInverse * skinned ).xyz;', 'transformed = skinned.xyz;');
const STABLE_SKINNORMAL_VERTEX = THREE.ShaderChunk.skinnormal_vertex.replace(
  'skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;', 'skinMatrix = skinMatrix * bindMatrix;');

if (STABLE_SKINNING_VERTEX === THREE.ShaderChunk.skinning_vertex || STABLE_SKINNORMAL_VERTEX === THREE.ShaderChunk.skinnormal_vertex)
  throw new Error('three.js skinning chunks changed: update stableSkinning.ts');

/** The material's vertex shader with mesh-relative skinning. Chains any hook the material has. */
export function stabilizeSkinnedMaterial<T extends THREE.Material>(material: T): T {
  if (material.userData.stableSkinning) return material;
  material.userData.stableSkinning = true;
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_vertex>', STABLE_SKINNING_VERTEX)
      .replace('#include <skinnormal_vertex>', STABLE_SKINNORMAL_VERTEX);
  };
  material.customProgramCacheKey = () => `${key()}|stableSkin`;
  return material;
}

const offset = new THREE.Matrix4(), toMesh = new THREE.Matrix4(), identity = new THREE.Matrix4();

/** Bone matrices relative to the mesh, written as three's Skeleton.update writes world ones. */
export function writeMeshRelativeBones(skeleton: THREE.Skeleton, meshWorld: THREE.Matrix4): void {
  toMesh.copy(meshWorld).invert();
  const { bones, boneInverses, boneMatrices } = skeleton;
  for (let i = 0; i < bones.length; i++) {
    offset.multiplyMatrices(bones[i] ? bones[i]!.matrixWorld : identity, boneInverses[i]!).premultiply(toMesh);
    offset.toArray(boneMatrices, i * 16);
  }
  if (skeleton.boneTexture !== null) skeleton.boneTexture.needsUpdate = true;
}

/**
 * Every skinned mesh under `root` whose skeleton drives only that mesh: mesh-relative bones, the
 * patched material (already owned by the caller) and a matching shadow material.
 */
export function stabilizeSkinning(root: THREE.Object3D): number {
  const users = new Map<THREE.Skeleton, THREE.SkinnedMesh[]>();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) users.set(mesh.skeleton, [...(users.get(mesh.skeleton) ?? []), mesh]);
  });
  let count = 0;
  for (const [skeleton, meshes] of users) {
    if (meshes.length !== 1) continue; // a skeleton shared by meshes at different places keeps three's own path
    const mesh = meshes[0]!;
    skeleton.update = () => writeMeshRelativeBones(skeleton, mesh.matrixWorld);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) stabilizeSkinnedMaterial(material);
    mesh.customDepthMaterial = stabilizeSkinnedMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
    count++;
  }
  return count;
}
