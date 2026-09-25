import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createScene } from '../src/scene.js';

// Source-level renderer wiring test; no WebGL context or browser FPS claim.
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof THREE>('three');
  return { ...actual, WebGLRenderer: class {
    shadowMap = { enabled: false, type: 0 };
    setPixelRatio = vi.fn(); setSize = vi.fn();
  } };
});
afterEach(() => vi.unstubAllGlobals());

describe('quality wired to the scene renderer', () => {
  it('requests paced shadow passes while preserving pending invalidation and initial maps', () => {
    vi.stubGlobal('devicePixelRatio', 1); vi.stubGlobal('addEventListener', vi.fn());
    const scene = createScene({ clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement);
    expect(scene.renderer.shadowMap.autoUpdate).toBe(false);
    scene.prepareShadows(0); expect(scene.renderer.shadowMap.needsUpdate).toBe(true);
    // Model the installed renderer consuming a successful pass.
    scene.sun.shadow.map = new THREE.WebGLRenderTarget(1, 1);
    scene.sun.shadow.needsUpdate = false; scene.renderer.shadowMap.needsUpdate = false;
    scene.prepareShadows(16); expect(scene.renderer.shadowMap.needsUpdate).toBe(false);
    scene.prepareShadows(34); expect(scene.renderer.shadowMap.needsUpdate).toBe(true);
    scene.prepareShadows(35); expect(scene.renderer.shadowMap.needsUpdate).toBe(true);
    scene.renderer.shadowMap.needsUpdate = false;
    scene.setQuality('smooth'); scene.prepareShadows(36);
    expect(scene.renderer.shadowMap.needsUpdate).toBe(true);
  });
  it('applies bounded pixels on startup, tier change and resize; releases replaced shadow targets', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('addEventListener', vi.fn());
    const canvas = { clientWidth: 3840, clientHeight: 2160 };
    const scene = createScene(canvas as HTMLCanvasElement);
    expect(scene.renderer.setPixelRatio).toHaveBeenLastCalledWith(0.5);
    expect(scene.renderer.setSize).toHaveBeenLastCalledWith(3840, 2160, false);
    expect(scene.sun.shadow.mapSize.x).toBe(1024);
    const target = new THREE.WebGLRenderTarget(1024, 1024);
    const dispose = vi.spyOn(target, 'dispose'); scene.sun.shadow.map = target;
    scene.setQuality('smooth');
    expect(dispose).toHaveBeenCalledTimes(1); expect(scene.sun.shadow.map).toBeNull();
    expect(scene.sun.shadow.mapSize.x).toBe(512);
    expect(scene.renderer.setPixelRatio).toHaveBeenLastCalledWith(1 / 3);
    canvas.clientWidth = 800; canvas.clientHeight = 600; scene.resize();
    expect(scene.renderer.setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(scene.camera.aspect).toBe(800 / 600);
    scene.setQuality('high');
    expect(scene.sun.shadow.mapSize.x).toBe(2048);
    expect(scene.renderer.setPixelRatio).toHaveBeenLastCalledWith(1.75);
  });
});
