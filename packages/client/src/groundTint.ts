import * as THREE from 'three';
import { GRID_SIZE, PATCH_METRES } from '@vana/shared';

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
}

/** How green grassland looks in each season when its grass is at full height. */
const SEASON_GREEN: Record<string, number> = { monsoon: 1, wet: 0.85, transition: 0.55, dry: 0.25 };

const hex = (value: number) => new THREE.Color(value);
const FAR = {
  lush: hex(0x5f9138), golden: hex(0xc2a35c), bare: hex(0xa88f64), canopy: hex(0x2c5426),
  riparian: hex(0x3f7a3a), marsh: hex(0x557a5a), rock: hex(0x8a8579), water: hex(0x2f6f86), sea: hex(0x235667),
};
const NEAR = {
  lush: hex(0x9fcf72), golden: hex(0xe6d29a), bare: hex(0xeadcc4), canopy: hex(0x8fb872),
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
    switch (patch.habitat) {
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

export class GroundTint {
  readonly near: THREE.DataTexture;
  readonly far: THREE.DataTexture;
  /** Camera distance (m) over which the ground turns from textured soil to map colour. */
  readonly farRange = { value: new THREE.Vector2(220, 1100) };
  #key = '';

  constructor(readonly size = GRID_SIZE) {
    const make = () => {
      const texture = new THREE.DataTexture(new Uint8Array(size * size * 4).fill(255), size, size, THREE.RGBAFormat);
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.colorSpace = THREE.NoColorSpace; // Values are already linear.
      texture.needsUpdate = true;
      return texture;
    };
    this.near = make(); this.far = make();
  }

  /** Recolours from the latest checkpoint. Returns false when nothing visible changed. */
  update(patches: readonly GroundPatch[], season: string): boolean {
    const key = season + JSON.stringify(patches.map((p) => [p.id, p.habitat, Math.round(grassFraction(p) * 50), Math.round((p.canopyCover ?? -1) * 50), p.surface]));
    if (key === this.#key) return false;
    this.#key = key;
    const near = this.near.image.data as Uint8Array, far = this.far.image.data as Uint8Array;
    for (const patch of patches) {
      if (patch.id < 0 || patch.id >= this.size * this.size) continue;
      const colours = patchGroundColours(patch, season), o = patch.id * 4;
      near.set([channel(colours.near.r), channel(colours.near.g), channel(colours.near.b), 255], o);
      far.set([channel(colours.far.r), channel(colours.far.g), channel(colours.far.b), 255], o);
    }
    this.near.needsUpdate = true; this.far.needsUpdate = true;
    return true;
  }

  /**
   * Adds the tint to a ground material. The mesh's vertex colour is used only as a sand mask on
   * the island's beaches (white inland).
   */
  apply(material: THREE.MeshStandardMaterial): void {
    const span = GRID_SIZE * PATCH_METRES;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.groundNear = { value: this.near };
      shader.uniforms.groundFar = { value: this.far };
      shader.uniforms.groundFarRange = this.farRange;
      shader.vertexShader = 'varying vec3 vGroundWorld;\n' + shader.vertexShader.replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = `uniform sampler2D groundNear; uniform sampler2D groundFar; uniform vec2 groundFarRange;
varying vec3 vGroundWorld;\n` + shader.fragmentShader.replace('#include <color_fragment>', `
        vec2 groundUv = (vGroundWorld.xz + ${(PATCH_METRES / 2).toFixed(1)}) / ${span.toFixed(1)};
        vec3 nearTint = texture2D(groundNear, groundUv).rgb;
        vec3 farColour = texture2D(groundFar, groundUv).rgb;
        #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
          float sand = 1.0 - vColor.b;
          vec3 sandColour = vec3(0.57, 0.46, 0.27);
          nearTint = mix(nearTint, vec3(1.0), sand);
          farColour = mix(farColour, sandColour, sand);
        #endif
        float groundFarness = smoothstep(groundFarRange.x, groundFarRange.y, distance(vGroundWorld, cameraPosition));
        diffuseColor.rgb = mix(diffuseColor.rgb * nearTint * 1.35, farColour, groundFarness);
      `);
    };
    material.customProgramCacheKey = () => 'vana-ground-tint';
    material.needsUpdate = true;
  }
}

/** One tint shared by every ground mesh the observer builds. */
export const groundTint = new GroundTint();
