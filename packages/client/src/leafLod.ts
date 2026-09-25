import * as THREE from 'three';

/** Full photographed foliage remains in the immediate observer space. */
export const LEAF_LOD_START_M = 24;
export const LEAF_LOD_END_M = 36;

/**
 * The two pinned broadleaf leaf primitives are independent four-vertex, two-triangle
 * cards. Retain alternate cards at middle distance without changing their UVs,
 * normals, textures, placement or the parent tree's branches and trunk. Attribute
 * buffers are shared with the full geometry; only the compact index buffer is new.
 * Unknown layouts fall back to the original geometry rather than corrupting art.
 */
export function alternateLeafCards(source: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const index = source.getIndex();
  const count = index?.count ?? 0;
  if (!index || count < 48 || count % 6 !== 0 || !source.getAttribute('position')) return null;
  for (let i = 0; i < count; i += 6) {
    const vertices = new Set<number>();
    for (let k = 0; k < 6; k++) vertices.add(index.getX(i + k));
    if (vertices.size !== 4) return null;
  }
  const retained = new Uint32Array(Math.ceil(count / 12) * 6);
  let length = 0;
  for (let i = 0; i < count; i += 12) {
    for (let k = 0; k < 6; k++) retained[length++] = index.getX(i + k);
  }
  const geometry = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.getAttribute(name));
  geometry.setIndex(new THREE.BufferAttribute(retained.subarray(0, length), 1));
  geometry.boundingBox = source.boundingBox?.clone() ?? null;
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
  return geometry;
}

/** Complementary screen-door leaf LOD, composed with the quality-tier tree/atlas fade. */
export function addLeafLodFade(material: THREE.Material, level: 'full' | 'middle'): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
      #include <alphatest_fragment>
      float leafBlend = smoothstep(${LEAF_LOD_START_M.toFixed(1)}, ${LEAF_LOD_END_M.toFixed(1)}, vTreeDistance);
      float leafNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (${level === 'full' ? 'leafNoise < leafBlend' : 'leafNoise >= leafBlend'}) discard;
    `);
  };
  material.customProgramCacheKey = () => `${key}:leaf-lod-${level}-v1`;
  material.needsUpdate = true;
}
