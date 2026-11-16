import * as THREE from 'three';

/**
 * Open water's look, shared by the Congo's rivers and flood (congoWater.ts) and its pools
 * (poolScene.ts): wind ripples, the forest and sky they mirror, and both kept moving and lit by
 * `animateWater` each frame. Drawn on canvases once; none outside a browser.
 */

let ripples: THREE.Texture | null | undefined;
/** Small wind ripples as a normal map, drawn once on a canvas (none outside a browser). */
function rippleNormals(): THREE.Texture | null {
  if (ripples !== undefined) return ripples;
  if (typeof document === 'undefined') return ripples = null;
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return ripples = null;
  const h = (x: number, y: number) => Math.sin(x * 0.29 + Math.sin(y * 0.11) * 2) * 0.5 + Math.sin(y * 0.37 + x * 0.07) * 0.35
    + Math.sin((x + y) * 0.53) * 0.15;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1), o = (y * size + x) * 4;
    image.data[o] = 128 + dx * 90; image.data[o + 1] = 128 + dy * 90; image.data[o + 2] = 255; image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return ripples = texture;
}

let forest: THREE.Texture | null | undefined;
/**
 * What still blackwater mirrors under a rainforest: a band of bright sky overhead, the dark green
 * wall of the forest around, and nothing below (an equirectangular image drawn once on a canvas).
 */
function forestReflection(): THREE.Texture | null {
  if (forest !== undefined) return forest;
  if (typeof document === 'undefined') return forest = null;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return forest = null;
  const sky = ctx.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, '#dfe6e2'); sky.addColorStop(0.28, '#a9b8a4'); sky.addColorStop(0.42, '#3d5230');
  sky.addColorStop(0.5, '#1d2a16'); sky.addColorStop(1, '#0c0f08');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 256, 128);
  // Crowns along the far bank break the horizon.
  for (let x = 0; x < 256; x += 3) {
    const top = 40 + Math.sin(x * 0.21) * 4 + Math.sin(x * 0.067) * 7;
    ctx.fillStyle = `hsl(${95 + (x % 17)}, 30%, ${14 + (x % 11)}%)`; ctx.fillRect(x, top, 3, 64 - top);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return forest = texture;
}

/** Every water surface drawn, with the reflection strength it has at full daylight. */
const waters = new Map<THREE.MeshStandardMaterial, number>();

/**
 * The look of open water, rivers and pools alike: wind ripples (a normal map) and the forest and
 * sky it mirrors. The material is registered, so `animateWater` moves its ripples and dims its
 * reflection with the light. Returns the parameters to spread into a MeshStandardMaterial.
 */
export function waterLook(reflection: number, ripple: number): Pick<THREE.MeshStandardMaterialParameters, 'envMap' | 'envMapIntensity' | 'normalMap' | 'normalScale'> {
  const normalMap = rippleNormals(), envMap = forestReflection();
  return { ...(envMap ? { envMap, envMapIntensity: reflection } : {}), ...(normalMap ? { normalMap, normalScale: new THREE.Vector2(ripple, ripple) } : {}) };
}
export function registerWater(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  waters.set(material, material.envMapIntensity);
  material.addEventListener('dispose', () => waters.delete(material));
  return material;
}

/**
 * Each frame: the ripples drift with the wind (`seconds` of real time), and the water mirrors as
 * much of the forest and sky as there is light (`daylight` 0-1), so it never shines at night.
 */
export function animateWater(seconds: number, daylight: number): void {
  const normals = rippleNormals();
  if (normals) normals.offset.set((seconds * 0.011) % 1, (seconds * 0.0067) % 1);
  for (const [material, full] of waters) material.envMapIntensity = full * (0.12 + 0.88 * Math.max(0, Math.min(1, daylight)));
}

