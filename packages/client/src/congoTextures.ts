import * as THREE from 'three';

/**
 * The Congo forest's photographic textures (public/assets/congo, generated for this project and
 * credited in ASSET-CREDITS.md): bark, leaf sprays, understory leaves, the leaf-litter floor and
 * the canopy seen from above. Each is loaded once; outside a browser (tests) there are none.
 */
export type CongoTexture = 'bark_pale' | 'bark_brown' | 'bark_raphia' | 'leaves_atlas' | 'marantaceae' | 'raphia_frond'
  | 'floor_litter' | 'canopy_aerial';

/** The leaf atlas is 2 x 2 sprays: dark glossy, bronze-flushed, feathery compound, dark turned. */
export const LEAF_ATLAS_TILES = 4;

const cache = new Map<CongoTexture, THREE.Texture>();

export function congoTexture(name: CongoTexture): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  let texture = cache.get(name);
  if (!texture) {
    texture = new THREE.TextureLoader().load(`/assets/congo/${name}.webp`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    // Bark, the floor and the canopy repeat; leaf cards are cut from their own image.
    if (name.startsWith('bark') || name === 'floor_litter' || name === 'canopy_aerial') texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    cache.set(name, texture);
  }
  return texture;
}
