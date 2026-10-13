import { habitatAnalogue } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import * as THREE from 'three';

import { standDensity } from './forestStructure.js';

/**
 * Ground colour from what the simulation reports, not a fixed habitat swatch.
 *
 * The scanned soil texture multiplied by a pale habitat tint made the whole island read as
 * mud, in the monsoon as much as in the dry season. Each patch now gets two colours:
 *
 * - near: a tint over the soil texture, greener where the grass is thick and paler where it
 *   has been grazed down or dried out
 * - far: a flat, map-like colour for when the camera is high or distant, where the texture
 *   tiles into noise: dense canopy reads as dark forest, grassland from gold to lush green
 *
 * Both live in 20x20 textures, filtered so habitats blend across patch edges, and are updated
 * each checkpoint without rebuilding the ground mesh. Presentation only.
 */

export interface GroundPatch {
  id: number;
  habitat: string;
  grass: number;
  canopyCover?: number;
  surface?: 'land' | 'coast' | 'ocean';
  /** Litres of standing surface water; dampens the floor toward moss. */
  water?: number;
  /** The last hydrology step; flowing water keeps its banks damp. */
  drainage?: { outflowL: number } | undefined;
}

/** How green grassland looks in each season when its grass is at full height. */
const SEASON_GREEN: Record<string, number> = { monsoon: 1, wet: 0.85, transition: 0.55, dry: 0.25 };

const hex = (value: number) => new THREE.Color(value);
const FAR = {
  lush: hex(0x5f9138), golden: hex(0xc2a35c), bare: hex(0xa88f64), canopy: hex(0x2c5426),
  riparian: hex(0x3f7a3a), marsh: hex(0x557a5a), rock: hex(0x8a8579), water: hex(0x2f6f86), sea: hex(0x235667),
};
const NEAR = {
  lush: hex(0xb4e67a), golden: hex(0xeedc9e), bare: hex(0xeadcc4), canopy: hex(0x9cc47a),
  riparian: hex(0x9fcb82), marsh: hex(0xa6c29d), rock: hex(0xd8d4ca), water: hex(0xa7c9cf), sea: hex(0x9fb8c0),
};

/** Grass fraction of a full sward, 0-1. */
const grassFraction = (patch: GroundPatch): number => Math.max(0, Math.min(1, patch.grass / 6000));

/** The two colours for one patch, in linear RGB. */
export function patchGroundColours(patch: GroundPatch, season: string): { near: THREE.Color; far: THREE.Color } {
  if (patch.surface === 'ocean') return { near: NEAR.sea.clone(), far: FAR.sea.clone() };
  const pick = (palette: typeof FAR): THREE.Color => {
    const greenness = grassFraction(patch) * (SEASON_GREEN[season] ?? 0.7);
    // Grass decides the open ground: thick and seasonal green, thin and grazed, or dry gold.
    const open = palette.golden.clone().lerp(palette.lush, greenness)
      .lerp(palette.bare, Math.max(0, 0.35 - grassFraction(patch)) / 0.35 * 0.6);
    switch (habitatAnalogue(patch.habitat)) {
      case 'rock': return palette.rock.clone();
      case 'water': return palette.water.clone();
      case 'marsh': return palette.marsh.clone().lerp(open, 0.25);
      case 'riparian': return palette.riparian.clone().lerp(open, 0.3);
      default: return open.lerp(palette.canopy, Math.max(0, Math.min(1, patch.canopyCover ?? (patch.habitat === 'shola' ? 0.8 : 0))));
    }
  };
  return { near: pick(NEAR), far: pick(FAR) };
}

const channel = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** How wet the forest floor is through each season, and how much leaf fall lies on it. */
const SEASON_WET: Record<string, number> = { monsoon: 1, wet: 0.75, transition: 0.4, dry: 0.15 };
const SEASON_LEAF_FALL: Record<string, number> = { monsoon: 0.3, wet: 0.45, transition: 0.8, dry: 1 };
const HABITAT_DAMP: Record<string, number> = { riparian: 0.7, marsh: 0.9, water: 1 };

export interface GroundLayers {
  /** Fallen leaves: under canopy, heaviest after the dry-season leaf drop. */
  litter: number;
  /** Bare red soil: where grass is grazed down or dried off and no canopy shades it. */
  bare: number;
  /** Moss and damp dark ground: wet seasons, standing or flowing water, shaded floors. */
  moss: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Shares of the floor in each layer for one patch, from its checkpointed canopy, grass and
 * water and the season. The shader spreads them over the patch with the same stand pattern
 * the trees use, so litter gathers under the clumps and soil shows in grazed clearings.
 */
export function groundLayers(patch: GroundPatch, season: string): GroundLayers {
  if (patch.surface === 'ocean' || patch.habitat === 'water') return { litter: 0, bare: 0, moss: 0 };
  const canopy = clamp01(patch.canopyCover ?? (patch.habitat === 'shola' ? 0.8 : 0));
  const grass = grassFraction(patch), wet = SEASON_WET[season] ?? 0.5, leafFall = SEASON_LEAF_FALL[season] ?? 0.6;
  const damp = Math.max(HABITAT_DAMP[habitatAnalogue(patch.habitat)] ?? 0, clamp01((patch.water ?? 0) / 60_000),
    clamp01((patch.drainage?.outflowL ?? 0) / 3_000));
  if (patch.habitat === 'rock') return { litter: 0, bare: round(0.35 * (1 - grass)), moss: round(0.3 * damp * wet) };
  return {
    litter: round(clamp01(canopy * (0.6 + 0.4 * leafFall))),
    bare: round(clamp01((1 - grass) * (1 - 0.6 * canopy) * (0.6 + 0.4 * (1 - wet)))),
    moss: round(clamp01(damp * 0.7 * wet + canopy * 0.35 * wet)),
  };
}
const round = (v: number) => Math.round(v * 50) / 50;

/** The stand pattern baked for the GPU: one texel per ~11.7 m across the 6 km island. */
export const STAND_TEXELS = 512;
export function bakeStandTexture(size = STAND_TEXELS): THREE.DataTexture {
  const span = worldGrid().cols * worldGrid().patchM, data = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    data[row * size + col] = channel(standDensity((col + 0.5) / size * span - worldGrid().patchM / 2,
      (row + 0.5) / size * span - worldGrid().patchM / 2));
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
  return texture;
}

/** Layer colours: near ones multiply the scanned soil, far ones replace it (linear RGB). */
const LAYER = {
  litterNear: hex(0xad9673), soilNear: hex(0xc49678), mossNear: hex(0x82a661),
  litterFar: hex(0x6b5233), soilFar: hex(0x8f5f3e), mossFar: hex(0x3b5a2a),
};
const vec3 = (c: THREE.Color | number[]) => `vec3(${(Array.isArray(c) ? c : [c.r, c.g, c.b]).map((v) => v.toFixed(4)).join(', ')})`;

export class GroundTint {
  readonly near: THREE.DataTexture;
  readonly far: THREE.DataTexture;
  /** Per-patch litter, bare-soil and moss shares (R, G, B). */
  readonly layers: THREE.DataTexture;
  #stand: THREE.DataTexture | null = null;
  /** Camera distance (m) over which the ground turns from textured soil to map colour. */
  readonly farRange = { value: new THREE.Vector2(220, 1100) };
  #key = '';

  /** Texels a side: one per patch column of the world drawn (20 on the island, 160 in the Congo forest). */
  get size(): number { return this.#size; }
  #size: number;

  constructor(size = worldGrid().cols) {
    this.#size = size;
    const make = () => {
      const texture = new THREE.DataTexture(new Uint8Array(size * size * 4).fill(255), size, size, THREE.RGBAFormat);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.colorSpace = THREE.NoColorSpace; // Values are already linear.
      texture.needsUpdate = true;
      return texture;
    };
    this.near = make(); this.far = make(); this.layers = make();
    (this.layers.image.data as Uint8Array).fill(0);
  }

  /** Congo 1A.4: the same texture objects (materials hold them), re-allocated for another lattice. */
  #resize(size: number): void {
    this.#size = size; this.#key = '';
    for (const [texture, fill] of [[this.near, 255], [this.far, 255], [this.layers, 0]] as const) {
      texture.image = { data: new Uint8Array(size * size * 4).fill(fill), width: size, height: size };
      texture.dispose(); texture.needsUpdate = true;
    }
    if (this.#stand) {
      const baked = bakeStandTexture();
      this.#stand.image = baked.image; this.#stand.dispose(); this.#stand.needsUpdate = true; baked.dispose();
    }
  }

  /** Baked on first use, not at import: tests and the server-side bundle never pay for it. */
  get stand(): THREE.DataTexture { return this.#stand ??= bakeStandTexture(); }

  /** Recolours from the latest checkpoint. Returns false when nothing visible changed. */
  update(patches: readonly GroundPatch[], season: string): boolean {
    if (worldGrid().cols !== this.#size) this.#resize(worldGrid().cols);
    const key = season + JSON.stringify(patches.map((p) => [p.id, p.habitat, Math.round(grassFraction(p) * 50),
      Math.round((p.canopyCover ?? -1) * 50), p.surface, Object.values(groundLayers(p, season))]));
    if (key === this.#key) return false;
    this.#key = key;
    const near = this.near.image.data as Uint8Array, far = this.far.image.data as Uint8Array;
    const layers = this.layers.image.data as Uint8Array;
    for (const patch of patches) {
      if (patch.id < 0 || patch.id >= this.size * this.size) continue;
      const colours = patchGroundColours(patch, season), o = patch.id * 4;
      near.set([channel(colours.near.r), channel(colours.near.g), channel(colours.near.b), 255], o);
      far.set([channel(colours.far.r), channel(colours.far.g), channel(colours.far.b), 255], o);
      const floor = groundLayers(patch, season);
      layers.set([channel(floor.litter), channel(floor.bare), channel(floor.moss), 255], o);
    }
    this.near.needsUpdate = true; this.far.needsUpdate = true; this.layers.needsUpdate = true;
    return true;
  }

  /**
   * Adds the tint to a ground material. The mesh's vertex colour is used only as a sand mask on
   * the island's beaches (white inland).
   */
  apply(material: THREE.MeshStandardMaterial): void {
    const span = worldGrid().cols * worldGrid().patchM;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.groundNear = { value: this.near };
      shader.uniforms.groundFar = { value: this.far };
      shader.uniforms.groundFarRange = this.farRange;
      shader.uniforms.groundLayers = { value: this.layers };
      shader.uniforms.groundStand = { value: this.stand };
      shader.vertexShader = 'varying vec3 vGroundWorld;\n' + shader.vertexShader.replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = `uniform sampler2D groundNear; uniform sampler2D groundFar; uniform vec2 groundFarRange;
uniform sampler2D groundLayers; uniform sampler2D groundStand;
varying vec3 vGroundWorld;
float groundHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float groundNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2(1.0, 0.0)), u.x),
    mix(groundHash(i + vec2(0.0, 1.0)), groundHash(i + vec2(1.0, 1.0)), u.x), u.y);
}\n` + shader.fragmentShader.replace('#include <color_fragment>', `
        vec2 groundUv = (vGroundWorld.xz + ${(worldGrid().patchM / 2).toFixed(1)}) / ${span.toFixed(1)};
        vec3 nearTint = texture2D(groundNear, groundUv).rgb;
        vec3 farColour = texture2D(groundFar, groundUv).rgb;
        // Litter, bare soil and moss shares for this patch, laid out by the trees' stand pattern
        // and a few metres of mottling, so the floor is not one flat olive from above.
        vec3 floorShare = texture2D(groundLayers, groundUv).rgb;
        float stand = texture2D(groundStand, groundUv).r;
        float mottle = groundNoise(vGroundWorld.xz / 6.0) * 0.6 + groundNoise(vGroundWorld.xz / 1.9) * 0.4;
        float litter = floorShare.r * smoothstep(0.2, 0.62, stand + (mottle - 0.5) * 0.45);
        float bare = floorShare.g * smoothstep(0.65, 0.15, stand + (mottle - 0.5) * 0.5) * smoothstep(0.3, 0.62, mottle);
        float moss = floorShare.b * smoothstep(0.45, 0.72, groundNoise(vGroundWorld.xz / 3.3 + 17.0) * 0.7 + mottle * 0.3);
        // Open sward is never one flat green: lusher hollows and paler, drier rises (~25 m).
        float sward = groundNoise(vGroundWorld.xz / 25.0 + 41.0) * 0.7 + mottle * 0.3;
        vec3 swardTone = mix(vec3(0.74, 0.86, 0.72), vec3(1.2, 1.12, 0.82), sward);
        nearTint *= mix(vec3(1.0), swardTone, 1.0 - litter);
        farColour *= mix(vec3(1.0), swardTone, (1.0 - litter) * 0.8);
        nearTint = mix(nearTint, ${vec3(LAYER.litterNear)}, litter);
        nearTint = mix(nearTint, ${vec3(LAYER.soilNear)}, bare * 0.9);
        nearTint = mix(nearTint, ${vec3(LAYER.mossNear)}, moss * 0.8);
        farColour = mix(farColour, ${vec3(LAYER.litterFar)}, litter * 0.55);
        farColour = mix(farColour, ${vec3(LAYER.soilFar)}, bare * 0.55);
        farColour = mix(farColour, ${vec3(LAYER.mossFar)}, moss * 0.45);
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          float sand = 1.0 - vColor.b;
          vec3 sandColour = vec3(0.57, 0.46, 0.27);
          nearTint = mix(nearTint, vec3(1.0), sand);
          farColour = mix(farColour, sandColour, sand);
        #endif
        float groundFarness = smoothstep(groundFarRange.x, groundFarRange.y, distance(vGroundWorld, cameraPosition));
        // The scanned soil is dark; lift it so near grassland reads green, not olive.
        diffuseColor.rgb = mix(diffuseColor.rgb * nearTint * 1.6, farColour, groundFarness);
      `);
    };
    // The world's span is compiled into the shader: one program per world size, not one shared.
    material.customProgramCacheKey = () => `vana-ground-tint-v2:${span}`;
    material.needsUpdate = true;
  }
}

/** One tint shared by every ground mesh the observer builds. */
export const groundTint = new GroundTint();
