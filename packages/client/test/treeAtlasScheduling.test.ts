import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { bakeTreeAtlas, TREE_ELEVATIONS, TREE_VIEWS } from '../src/treeLod.js';
import { NearVegetation } from '../src/vegetation.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Real Three cameras/targets/materials; only GL commands are replaced. This proves scheduling
 * and shared-renderer isolation, not rendered pixels, GPU timings or browser smoothness. */
class RecordingRenderer {
  target: THREE.WebGLRenderTarget | null = new THREE.WebGLRenderTarget(900, 700);
  face = 2; mip = 1;
  viewport = new THREE.Vector4(5, 7, 890, 680);
  scissor = new THREE.Vector4(10, 20, 300, 200);
  scissorTest = true;
  clearColor = new THREE.Color(0xabc123); clearAlpha = .7;
  autoClear = true; toneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
  clearCalls = 0; failAt = -1;
  atlas: THREE.WebGLRenderTarget | null = null;
  disposed = 0;
  renders: Array<{ viewport: number[]; position: number[]; matrix: number[]; mipmaps: boolean; minFilter: number }> = [];
  getRenderTarget() { return this.target; }
  getActiveCubeFace() { return this.face; }
  getActiveMipmapLevel() { return this.mip; }
  getViewport(v: THREE.Vector4) { return v.copy(this.viewport); }
  getScissor(v: THREE.Vector4) { return v.copy(this.scissor); }
  getScissorTest() { return this.scissorTest; }
  getClearColor(c: THREE.Color) { return c.copy(this.clearColor); }
  getClearAlpha() { return this.clearAlpha; }
  setRenderTarget(target: THREE.WebGLRenderTarget | null, face = 0, mip = 0) {
    this.target = target; this.face = face; this.mip = mip;
    // Three also restores target viewport/scissor; explicit custom viewport restoration matters.
    this.viewport.set(0, 0, target?.width ?? 1000, target?.height ?? 800);
    this.scissor.copy(this.viewport); this.scissorTest = false;
  }
  setViewport(...args: [THREE.Vector4] | [number, number, number, number]) {
    if (args.length === 1) this.viewport.copy(args[0]); else this.viewport.set(...args);
  }
  setScissor(...args: [THREE.Vector4] | [number, number, number, number]) {
    if (args.length === 1) this.scissor.copy(args[0]); else this.scissor.set(...args);
  }
  setScissorTest(value: boolean) { this.scissorTest = value; }
  setClearColor(color: THREE.ColorRepresentation, alpha: number) { this.clearColor.set(color); this.clearAlpha = alpha; }
  clear() {
    expect(this.scissorTest).toBe(false); expect(this.clearAlpha).toBe(0);
    this.clearCalls++; this.atlas = this.target;
    this.atlas!.addEventListener('dispose', () => this.disposed++);
  }
  render(scene: THREE.Scene, camera: THREE.OrthographicCamera) {
    expect(this.autoClear).toBe(false); expect(this.toneMapping).toBe(THREE.NoToneMapping);
    expect(this.scissorTest).toBe(true); expect(this.scissor).toEqual(this.viewport);
    expect(this.target).toBe(this.atlas);
    for (const object of scene.children) {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        expect(material.customProgramCacheKey()).not.toContain('tree-detail');
      }
    }
    this.renders.push({ viewport: this.viewport.toArray(), position: camera.position.toArray(),
      matrix: camera.matrixWorld.toArray(), mipmaps: this.target!.texture.generateMipmaps,
      minFilter: this.target!.texture.minFilter });
    if (this.renders.length === this.failAt) throw new Error('GPU draw failed');
  }
  state() {
    return { target: this.target, face: this.face, mip: this.mip, viewport: this.viewport.toArray(),
      scissor: this.scissor.toArray(), scissorTest: this.scissorTest, color: this.clearColor.toArray(),
      alpha: this.clearAlpha, autoClear: this.autoClear, toneMapping: this.toneMapping };
  }
}
const source = () => [new THREE.InstancedMesh(new THREE.BoxGeometry(4, 8, 6).translate(2, 4, -1), new THREE.MeshStandardMaterial(), 1)];
const renderer = (r: RecordingRenderer) => r as unknown as THREE.WebGLRenderer;
// The GLTF parser is an on-demand chunk; a microtask-only drain cannot cross its module-load boundary.
const flush = async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); for (let i = 0; i < 12; i++) await Promise.resolve(); };
const expectAbort = (promise: Promise<unknown>): Promise<void> => promise.then(
  () => { throw new Error('Expected an AbortError'); },
  error => { expect(error).toMatchObject({ name: 'AbortError' }); },
);
const waitForFrame = async (callbacks: Map<number, FrameRequestCallback>): Promise<void> => {
  await vi.waitFor(() => expect(callbacks.size).toBe(1), { timeout: 1000, interval: 2 });
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('frame-sliced atlas baking', () => {
  it('yields before each identical view and preserves the newest renderer state at every boundary', async () => {
    const r = new RecordingRenderer(), meshes = source();
    let expected = r.state(), frames = 0, finished = false;
    const promise = bakeTreeAtlas(renderer(r), meshes, { nextFrame: async () => {
      expect(r.state()).toEqual(expected); expect(r.renders).toHaveLength(frames);
      expect(finished).toBe(false);
      // Live viewer may resize, select quality, or render to a new target between slices.
      r.viewport.set(frames, frames + 1, 700 + frames, 500 + frames);
      r.scissor.set(30, frames, 400, 250); r.scissorTest = frames % 2 === 0;
      r.clearColor.setRGB(frames / 24, .2, .3); r.clearAlpha = frames / 24;
      r.autoClear = frames % 2 === 0; r.toneMapping = THREE.ReinhardToneMapping;
      r.face = frames % 6; r.mip = frames % 3;
      expected = r.state(); frames++;
    } });
    void promise.then(() => { finished = true; });
    expect(r.renders).toHaveLength(0); // even first view doesn't join the GLTF decode task
    const atlas = await promise;
    expect(finished).toBe(true); expect(frames).toBe(TREE_ELEVATIONS * TREE_VIEWS);
    expect(r.state()).toEqual(expected); expect(r.clearCalls).toBe(1); expect(r.disposed).toBe(0);
    const bounds = new THREE.Box3().setFromBufferAttribute(meshes[0]!.geometry.attributes.position as THREE.BufferAttribute);
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()), radius = sphere.radius * 1.05;
    expect(atlas.centre).toEqual(sphere.center); expect(atlas.diameter).toBe(radius * 2);
    const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, .01, radius * 8);
    r.renders.forEach((pass, i) => {
      const row = Math.floor(i / TREE_VIEWS), column = i % TREE_VIEWS;
      const elevation = Math.min(row * Math.PI / 4, Math.PI / 2 - .001), angle = column * Math.PI * 2 / TREE_VIEWS;
      camera.position.set(Math.sin(angle) * Math.cos(elevation), Math.sin(elevation), Math.cos(angle) * Math.cos(elevation))
        .multiplyScalar(radius * 3).add(sphere.center);
      camera.lookAt(sphere.center); camera.updateMatrixWorld();
      expect(pass.position).toEqual(camera.position.toArray()); expect(pass.matrix).toEqual(camera.matrixWorld.toArray());
      expect(pass.viewport).toEqual([column * 256, row * 256, 256, 256]);
      expect(pass.mipmaps).toBe(i === 23);
      expect(pass.minFilter).toBe(i === 23 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter);
    });
    atlas.target.dispose(); r.target?.dispose(); meshes[0]!.geometry.dispose(); (meshes[0]!.material as THREE.Material).dispose();
  });

  it('leaves a scan\'s buried soil skirt out of the atlas only while baking', async () => {
    class ClipRecorder extends RecordingRenderer {
      localClippingEnabled = false;
      clips: Array<{ local: boolean; constant: number | undefined }> = [];
      override render(scene: THREE.Scene, camera: THREE.OrthographicCamera) {
        const mesh = scene.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh;
        this.clips.push({ local: this.localClippingEnabled,
          constant: (mesh.material as THREE.Material).clippingPlanes?.[0]?.constant });
        super.render(scene, camera);
      }
    }
    const r = new ClipRecorder(), meshes = source();
    const atlas = await bakeTreeAtlas(renderer(r), meshes, { clipBelow: 0.3, nextFrame: async () => {
      // Between views the live scene shares these materials: never clipped there.
      expect((meshes[0]!.material as THREE.Material).clippingPlanes).toBeNull();
      expect(r.localClippingEnabled).toBe(false);
    } });
    expect(r.clips).toHaveLength(TREE_ELEVATIONS * TREE_VIEWS);
    expect(r.clips.every((clip) => clip.local && clip.constant === -0.3)).toBe(true);
    expect((meshes[0]!.material as THREE.Material).clippingPlanes).toBeNull();
    expect(r.localClippingEnabled).toBe(false);
    atlas.target.dispose(); r.target?.dispose(); meshes[0]!.geometry.dispose(); (meshes[0]!.material as THREE.Material).dispose();
  });

  it('restores state and releases only its target after a render failure or a failed frame wait', async () => {
    for (const failure of ['draw', 'wait']) {
      const r = new RecordingRenderer(), meshes = source(), before = r.state(); let frames = 0;
      if (failure === 'draw') r.failAt = 3;
      const sourceGeometry = vi.spyOn(meshes[0]!.geometry, 'dispose');
      const sourceMaterial = vi.spyOn(meshes[0]!.material as THREE.Material, 'dispose');
      await expect(bakeTreeAtlas(renderer(r), meshes, { nextFrame: async () => {
        frames++; if (failure === 'wait' && frames === 4) throw new Error('Frame scheduler failed');
      } })).rejects.toThrow(failure === 'draw' ? 'GPU draw failed' : 'Frame scheduler failed');
      expect(r.state()).toEqual(before); expect(r.renders).toHaveLength(3); expect(r.disposed).toBe(1);
      expect(sourceGeometry).not.toHaveBeenCalled(); expect(sourceMaterial).not.toHaveBeenCalled();
      r.target?.dispose(); meshes[0]!.geometry.dispose(); (meshes[0]!.material as THREE.Material).dispose();
    }
  });

  it('cancels a pending real RAF boundary immediately and never renders another partial view', async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
    const cancel = vi.fn((handle: number) => { callbacks.delete(handle); }); vi.stubGlobal('cancelAnimationFrame', cancel);
    const r = new RecordingRenderer(), meshes = source(), before = r.state(), lifetime = new AbortController();
    const promise = bakeTreeAtlas(renderer(r), meshes, { signal: lifetime.signal });
    const rejected = expectAbort(promise);
    expect(callbacks.size).toBe(1); const first = callbacks.get(1)!; callbacks.delete(1); first(16); await flush();
    expect(r.renders).toHaveLength(1); expect(callbacks.size).toBe(1); expect(r.state()).toEqual(before);
    lifetime.abort(); await rejected;
    expect(cancel).toHaveBeenCalledWith(2); expect(callbacks.size).toBe(0); expect(r.disposed).toBe(1);
    expect(r.renders).toHaveLength(1); expect(r.state()).toEqual(before);
    await expect(bakeTreeAtlas(renderer(r), meshes, { signal: lifetime.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(callbacks.size).toBe(0);
    r.target?.dispose(); meshes[0]!.geometry.dispose(); (meshes[0]!.material as THREE.Material).dispose();
  });

  it('never publishes partial tree LOD and aborts/disposes the owning layer during baking', async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { callbacks.delete(handle); });
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), new THREE.MeshStandardMaterial()));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as never);
    const layer = new NearVegetation([], () => 0), r = new RecordingRenderer();
    const promise = layer.load(renderer(r)); const rejected = expectAbort(promise);
    await waitForFrame(callbacks); expect(layer.hasTreeLod).toBe(false);
    const first = callbacks.get(1)!; callbacks.delete(1); first(16);
    await vi.waitFor(() => { expect(r.renders).toHaveLength(1); expect(callbacks.size).toBe(1); }, { timeout: 1000, interval: 2 });
    expect(layer.hasTreeLod).toBe(false);
    layer.dispose(); await rejected;
    expect(layer.root.children).toHaveLength(0); expect(layer.hasTreeLod).toBe(false);
    expect(r.disposed).toBe(1); expect(callbacks.size).toBe(0);
    await expect(layer.load(renderer(r))).rejects.toMatchObject({ name: 'AbortError' });
    r.target?.dispose();
  });

  it('awaits all three source atlases before publishing a complete reusable layer', async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { callbacks.delete(handle); });
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), new THREE.MeshStandardMaterial()));
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as never);
    const layer = new NearVegetation([], () => 0), r = new RecordingRenderer();
    let finished = false;
    const promise = layer.load(renderer(r)).then(() => { finished = true; });
    for (let frame = 1; frame <= 72; frame++) {
      await waitForFrame(callbacks); expect(finished).toBe(false); expect(layer.hasTreeLod).toBe(false);
      const [handle, callback] = callbacks.entries().next().value!;
      callbacks.delete(handle); callback(frame * 1000 / 60);
    }
    await promise;
    expect(finished).toBe(true); expect(layer.hasTreeLod).toBe(true); expect(callbacks.size).toBe(0);
    expect(r.renders).toHaveLength(72); expect(r.clearCalls).toBe(3); expect(r.disposed).toBe(0);
    layer.dispose(); expect(r.disposed).toBe(3); expect(layer.root.children).toHaveLength(0);
    r.target?.dispose();
  });

  it('cleans late model arrivals instead of resurrecting a disposed layer', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(pending as never);
    const layer = new NearVegetation([], () => 0);
    const promise = layer.load(); const rejected = expectAbort(promise);
    await vi.waitFor(() => expect(load).toHaveBeenCalled(), { timeout: 1000, interval: 2 });
    layer.dispose();
    const texture = new THREE.Texture(), textureDispose = vi.spyOn(texture, 'dispose');
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), new THREE.MeshStandardMaterial({ map: texture })));
    resolve({ scene }); await rejected;
    expect(layer.hasTreeLod).toBe(false); expect(layer.root.children).toHaveLength(0);
    expect(textureDispose).toHaveBeenCalledTimes(1);
  });
});
