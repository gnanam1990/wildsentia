import * as THREE from 'three';

/** A reversible display-grade pass for the three local Asian-elephant variants.
 * Keep the original textured GLBs intact: this only mutes strongly warm, dark
 * skin pixels. Bright ivory and nails keep their source colour. Pass false only
 * for already-owned per-animal materials: Three.js clone() drops shader hooks. */
export function elephantSurface(root: THREE.Object3D, cloneMaterials = true): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const grade = (source: THREE.Material): THREE.Material => {
      if (!(source instanceof THREE.MeshStandardMaterial) || !source.map) return source;
      const material = cloneMaterials ? source.clone() : source;
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          float vanaLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          float vanaWarm = smoothstep(0.012, 0.11, diffuseColor.r - diffuseColor.b);
          float vanaSkin = vanaWarm * (1.0 - smoothstep(0.26, 0.48, vanaLuma));
          float vanaValue = pow(max(vanaLuma, 0.001), 0.70);
          vec3 vanaEarthGrey = vec3(vanaValue * 0.94, vanaValue * 0.97, vanaValue);
          diffuseColor.rgb = mix(diffuseColor.rgb, vanaEarthGrey, vanaSkin * 0.92);`);
      };
      material.customProgramCacheKey = () => 'vana-elephant-earth-grey-v2';
      return material;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(grade) : grade(mesh.material);
  });
}
