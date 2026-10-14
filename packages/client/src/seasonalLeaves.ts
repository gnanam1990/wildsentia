import type * as THREE from 'three';

/**
 * The island's monsoon forest through the year: its deciduous trees (teak, sal) drop much of their
 * leaf in the dry season, yellowing first, and green again with the rains. Presentation only: the
 * simulation's canopy cover is untouched; ground litter already follows the season (groundTint.ts).
 */
const DRYNESS: Record<string, number> = { monsoon: 0, wet: 0.1, transition: 0.45, dry: 0.85 };

/** 0 (full green leaf) to 1 (most leaf dropped), for the world's season name. */
export function seasonalDryness(season: string): number {
  return DRYNESS[season] ?? 0;
}

/**
 * Tints a canopy's green pixels toward dry yellow-brown by the shared `dryness` uniform, and on
 * near leaf cards (`thins`) drops a share of the leaf so the crown opens as the season dries. Bark,
 * soil and anything not green are left alone, so the same hook serves the distant atlas impostors.
 */
export function addSeasonalLeaves(material: THREE.Material, dryness: { value: number }, thins: boolean): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uSeasonDry = dryness;
    shader.fragmentShader = `uniform float uSeasonDry;\n${shader.fragmentShader}`.replace('#include <map_fragment>', `
      #include <map_fragment>
      // How green this pixel is: leaves, not bark or soil.
      float leafMask = smoothstep(0.02, 0.12, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
      vec3 dryLeaf = vec3(dot(diffuseColor.rgb, vec3(0.42, 0.42, 0.16))) * vec3(1.35, 1.05, 0.55);
      diffuseColor.rgb = mix(diffuseColor.rgb, dryLeaf, uSeasonDry * 0.75 * leafMask);
      ${thins ? `
      float leafFall = fract(43.7585453 * fract(dot(gl_FragCoord.xy, vec2(0.0413, 0.0217))));
      if (leafMask > 0.5 && leafFall < uSeasonDry * 0.5) discard;` : ''}
    `);
  };
  material.customProgramCacheKey = () => `${key}:season-leaves-${thins ? 'thin' : 'tint'}-v1`;
  material.needsUpdate = true;
}

/**
 * The Congo forest is semi-evergreen. Its deciduous canopy trees (ayous, limba, kapok; about a
 * quarter of crowns in the northern semi-deciduous forest, an assumption) turn and shed in the
 * two drier spells of the Congo calendar ('transition'), and leaf out again with the rains.
 */
export const CONGO_DECIDUOUS_SHARE = 0.25;
const CONGO_DRYNESS: Record<string, number> = { monsoon: 0, wet: 0, transition: 0.8 };

/** 0 (in leaf) to 1 (bare), for a deciduous Congo crown in the world's season. */
export function congoSeasonalDryness(season: string): number {
  return CONGO_DRYNESS[season] ?? 0;
}

/**
 * Turns and thins the deciduous share of a Congo plant's leaves: the crown is chosen by where its
 * instance stands, and leaf drops in clumps fixed on the plant (so nothing swims as the camera
 * moves). `depth` is the leaves' shadow material: shed leaf casts no shade.
 */
export function addCongoDeciduous(material: THREE.Material, dryness: { value: number }, part: 'leaves' | 'depth'): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.uSeasonDry = dryness;
    shader.vertexShader = `varying float vDeciduous; varying vec3 vLeafSpot;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vLeafSpot = transformed;
      vDeciduous = 0.0;
      #ifdef USE_INSTANCING
        vDeciduous = step(fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453), ${CONGO_DECIDUOUS_SHARE.toFixed(3)});
      #endif
    `);
    const fall = `
      float leafFall = fract(sin(dot(floor(vLeafSpot * 3.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      if (leafFall < uSeasonDry * vDeciduous * 0.7) discard;`;
    const head = 'uniform float uSeasonDry; varying float vDeciduous; varying vec3 vLeafSpot;\n';
    shader.fragmentShader = part === 'leaves'
      ? head + shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec3 dryLeaf = vec3(dot(diffuseColor.rgb, vec3(0.42, 0.42, 0.16))) * vec3(1.4, 1.0, 0.5);
      diffuseColor.rgb = mix(diffuseColor.rgb, dryLeaf, uSeasonDry * vDeciduous * 0.85);${fall}`)
      : head + shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>${fall}`);
  };
  material.customProgramCacheKey = () => `${key}:congo-deciduous-${part}-v1`;
  material.needsUpdate = true;
}
