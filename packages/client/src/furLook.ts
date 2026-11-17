import * as THREE from 'three';

/**
 * Fur and feathers catch the light along an animal's outline: the hairs at a grazing angle
 * scatter it back toward the eye. Without that the models read as smooth clay. This adds that
 * edge light to an animal's own (cloned) material, scaled by the light the surface actually
 * receives, so it glows in sunlight, softens in shade and is gone at night.
 */
export const FUR_EDGE = { strength: 0.55, power: 2.6 };

export const FUR_FRAGMENT = /* glsl */`
  {
    float furFacing = abs(dot(normal, geometryViewDir));
    float furEdge = pow(1.0 - furFacing, ${FUR_EDGE.power.toFixed(2)}) * ${FUR_EDGE.strength.toFixed(2)};
    outgoingLight += (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) * furEdge;
  }
  #include <opaque_fragment>`;

/** Adds the edge light once, keeping any shader hook the material already has. */
export function applyFurLook(material: THREE.Material): void {
  const standard = material as THREE.MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial || standard.userData.furLook) return;
  standard.userData.furLook = true;
  const before = standard.onBeforeCompile.bind(standard), key = standard.customProgramCacheKey.bind(standard);
  standard.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', FUR_FRAGMENT);
  };
  standard.customProgramCacheKey = () => `${key()}|fur`;
}
