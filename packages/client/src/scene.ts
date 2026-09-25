import * as THREE from 'three';
import { RENDER_BUDGETS, renderPixelRatio, ShadowCadence, type RenderTier } from './renderQuality.js';

export interface SceneBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  resize(): void;
  setQuality(tier: RenderTier): void;
  prepareShadows(now: number): void;
}

export function createScene(canvas: HTMLCanvasElement): SceneBundle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let quality: RenderTier = 'balanced';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const shadows = new ShadowCadence();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8c4);
  scene.fog = new THREE.Fog(0x9fb8c4, 200, 2600);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 12_000);

  scene.add(new THREE.HemisphereLight(0xcfe3ef, 0x3f4a33, 1.1));

  const sun = new THREE.DirectionalLight(0xffeccf, 2.2);
  sun.position.set(400, 800, 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const resize = (): void => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(renderPixelRatio(quality, w, h, devicePixelRatio));
    renderer.setSize(w, h, false);
  };
  resize();
  addEventListener('resize', resize);

  const setQuality = (tier: RenderTier): void => {
    quality = tier;
    const size = RENDER_BUDGETS[tier].shadowSize;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.map?.dispose(); sun.shadow.map = null;
      sun.shadow.mapSize.set(size, size); sun.shadow.needsUpdate = true;
    }
    resize();
  };
  const prepareShadows = (now: number): void => {
    // Three resets needsUpdate after actually drawing the shadow pass. Do not cancel
    // an outstanding invalidation (including map-size changes or a missing first map).
    if (shadows.next(now, quality, sun.target.position, sun.position, sun.shadow.map === null || sun.shadow.needsUpdate)) {
      renderer.shadowMap.needsUpdate = true;
    }
  };
  return { renderer, scene, camera, sun, resize, setQuality, prepareShadows };
}
