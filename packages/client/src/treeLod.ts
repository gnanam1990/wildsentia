import * as THREE from 'three';
import type { RenderTier } from './renderQuality.js';

/** One shared transition for full geometry and its own atlas, not unrelated placeholder trees. */
export const TREE_FADE_START_M = 50;
export const TREE_FADE_END_M = 80;
export const TREE_PLAN_MARGIN_M = 24;
export const FOREST_RADIUS_M = 2800; // Beyond the longest atmosphere fog distance (2600 m).
export const TREE_VIEWS = 8;
export const TREE_ELEVATIONS = 3;
const TILE = 256;

/** The same range drives both real geometry and its matching atlas. Lower tiers spend
 * fewer vertices on dense nearby crowns without thinning the shared forest. */
export const TREE_FADE_BY_TIER: Readonly<Record<RenderTier, readonly [number, number]>> = {
  smooth: [24, 42], balanced: [35, 60], high: [TREE_FADE_START_M, TREE_FADE_END_M],
};

export function treeFadeRangeFor(tier: RenderTier): THREE.Vector2 {
  const [start, end] = TREE_FADE_BY_TIER[tier];
  return new THREE.Vector2(start, end);
}

export function treeDetailWeight(distance: number): number {
  const t = Math.max(0, Math.min(1, (distance - TREE_FADE_START_M) / (TREE_FADE_END_M - TREE_FADE_START_M)));
  return 1 - t * t * (3 - 2 * t);
}

export function treeAtlasView(azimuth: number, elevation: number): { column: number; row: number } {
  const turn = Math.PI * 2;
  return {
    column: ((Math.floor(azimuth / turn * TREE_VIEWS + 0.5) % TREE_VIEWS) + TREE_VIEWS) % TREE_VIEWS,
    row: Math.round(Math.max(0, Math.min(Math.PI / 2, elevation)) / (Math.PI / 4)),
  };
}

const transition = `
  float detail = 1.0 - smoothstep(treeFadeRange.x, treeFadeRange.y, vTreeDistance);
  float screenNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
`;

/** Preserve source material hooks (e.g. evergreen foliage), and use the actual observer camera
 * even in the shadow pass. Dithering writes depth; no transparent-tree sorting artefacts. */
export function addTreeDetailFade(material: THREE.Material, observer: { value: THREE.Vector3 },
  fadeRange: { value: THREE.Vector2 } = { value: treeFadeRangeFor('high') }): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.treeObserver = observer;
    shader.uniforms.treeFadeRange = fadeRange;
    shader.vertexShader = 'uniform vec3 treeObserver; varying float vTreeDistance;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vTreeDistance = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, treeObserver);
    `);
    shader.fragmentShader = 'uniform vec2 treeFadeRange; varying float vTreeDistance;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
      #include <alphatest_fragment>
      ${transition}
      if (screenNoise >= detail) discard;
    `);
  };
  material.customProgramCacheKey = () => `${key}:tree-detail-v2`;
  material.needsUpdate = true;
}

export interface TreeAtlas {
  target: THREE.WebGLRenderTarget;
  centre: THREE.Vector3;
  diameter: number;
}

/** Wait without polling or retaining an RAF callback after disposal. Hidden tabs naturally
 * defer this optional visual work until RAF resumes; abort still settles immediately. */
function nextAtlasFrame(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = (): void => { cancelAnimationFrame(handle); reject(signal!.reason); };
    const handle = requestAnimationFrame(() => {
      signal?.removeEventListener('abort', abort); resolve();
    });
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface AtlasBakeOptions {
  signal?: AbortSignal;
  /** Injectable frame boundary for deterministic, GPU-free scheduling tests. */
  nextFrame?: (signal?: AbortSignal) => Promise<void>;
  /** Local height below which the source is left out of the atlas: a scan's soil skirt. The
   * placed tree is sunk by this much, so a distant card showing it drew a pale ring at every
   * trunk from above. Near geometry is unchanged. */
  clipBelow?: number;
}

/** Bake identical local views, one view per animation-frame boundary. A single GPU draw or
 * shader compilation cannot be preempted, so this is a work-unit cap, not a millisecond guarantee.
 * Restore renderer state before EVERY yield: the live scene shares this renderer. */
export async function bakeTreeAtlas(renderer: THREE.WebGLRenderer, source: readonly THREE.InstancedMesh[],
  options: AtlasBakeOptions = {}): Promise<TreeAtlas> {
  options.signal?.throwIfAborted();
  const scene = new THREE.Scene();
  for (const original of source) scene.add(new THREE.Mesh(original.geometry, original.material));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x787c69, 2));
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(5, 12, 8); scene.add(light);
  const bounds = new THREE.Box3().setFromObject(scene);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius * 1.05;
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 8);
  const clipped = options.clipBelow === undefined ? [] : [...new Set(source.flatMap((mesh) =>
    Array.isArray(mesh.material) ? mesh.material : [mesh.material]))];
  const clipPlanes = clipped.length ? [new THREE.Plane(new THREE.Vector3(0, 1, 0), -options.clipBelow!)] : null;
  const target = new THREE.WebGLRenderTarget(TILE * TREE_VIEWS, TILE * TREE_ELEVATIONS, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  try {
    for (let row = 0; row < TREE_ELEVATIONS; row++) {
      const elevation = Math.min(row * Math.PI / 4, Math.PI / 2 - 0.001);
      for (let column = 0; column < TREE_VIEWS; column++) {
        await (options.nextFrame ?? nextAtlasFrame)(options.signal);
        options.signal?.throwIfAborted();
        const angle = column * Math.PI * 2 / TREE_VIEWS;
        camera.position.set(Math.sin(angle) * Math.cos(elevation), Math.sin(elevation), Math.cos(angle) * Math.cos(elevation))
          .multiplyScalar(radius * 3).add(sphere.center);
        camera.lookAt(sphere.center); camera.updateMatrixWorld();
        // Capture fresh state, not a stale pre-load snapshot: the live viewer may have
        // resized, changed exposure/quality, or rendered to another target while we yielded.
        const previous = {
          target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
          viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
          scissorTest: renderer.getScissorTest(), clear: renderer.getClearColor(new THREE.Color()),
          alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear, tone: renderer.toneMapping,
          localClipping: renderer.localClippingEnabled,
        };
        try {
          renderer.setRenderTarget(target);
          if (row === 0 && column === 0) {
            renderer.setScissorTest(false); renderer.setClearColor(0x000000, 0); renderer.clear();
          }
          renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping;
          if (clipPlanes) {
            renderer.localClippingEnabled = true;
            for (const material of clipped) material.clippingPlanes = clipPlanes;
          }
          renderer.setScissorTest(true);
          renderer.setViewport(column * TILE, row * TILE, TILE, TILE);
          renderer.setScissor(column * TILE, row * TILE, TILE, TILE);
          // Build mipmaps only after the complete atlas, never for partial intermediate views.
          if (row === TREE_ELEVATIONS - 1 && column === TREE_VIEWS - 1) {
            target.texture.generateMipmaps = true;
            target.texture.minFilter = THREE.LinearMipmapLinearFilter;
          }
          renderer.render(scene, camera);
        } finally {
          renderer.setRenderTarget(previous.target, previous.face, previous.mip);
          renderer.setViewport(previous.viewport); renderer.setScissor(previous.scissor);
          renderer.setScissorTest(previous.scissorTest); renderer.setClearColor(previous.clear, previous.alpha);
          renderer.autoClear = previous.autoClear; renderer.toneMapping = previous.tone;
          renderer.localClippingEnabled = previous.localClipping;
          // The live scene shares these materials; never leave them clipped across a yield.
          for (const material of clipped) material.clippingPlanes = null;
        }
      }
    }
  } catch (error) {
    target.dispose(); throw error;
  }
  return { target, centre: sphere.center, diameter: radius * 2 };
}

export function treeImpostorMaterial(atlas: TreeAtlas,
  fadeRange: { value: THREE.Vector2 } = { value: treeFadeRangeFor('high') }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map: atlas.target.texture, alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.treeCentre = { value: atlas.centre };
    shader.uniforms.treeDiameter = { value: atlas.diameter };
    shader.uniforms.treeFadeRange = fadeRange;
    shader.vertexShader = `uniform vec3 treeCentre; uniform float treeDiameter;
      varying float vTreeDistance; varying vec2 vTreeTile;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 treeWorld = modelMatrix * instanceMatrix * vec4(treeCentre, 1.0);
      vec3 treeDirection = cameraPosition - treeWorld.xyz;
      float yaw = atan(instanceMatrix[2].x, instanceMatrix[2].z);
      float angle = atan(treeDirection.x, treeDirection.z) - yaw;
      float column = mod(floor(angle / 6.28318530718 * 8.0 + 0.5), 8.0);
      float elevation = atan(max(0.0, treeDirection.y), length(treeDirection.xz));
      float row = clamp(floor(elevation / 0.78539816339 + 0.5), 0.0, 2.0);
      vTreeTile = vec2(column, row);
      vTreeDistance = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, cameraPosition);
      vec4 mvPosition = viewMatrix * treeWorld;
      mvPosition.xy += position.xy * treeDiameter * length(instanceMatrix[0].xyz);
      gl_Position = projectionMatrix * mvPosition;
    `);
    shader.fragmentShader = 'uniform vec2 treeFadeRange; varying float vTreeDistance; varying vec2 vTreeTile;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      // Half-texel inset prevents colour leaking from an adjacent view.
      vec2 atlasUv = (vTreeTile + mix(vec2(0.002), vec2(0.998), vMapUv)) / vec2(8.0, 3.0);
      diffuseColor *= texture2D(map, atlasUv);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
      #include <alphatest_fragment>
      ${transition}
      if (screenNoise < detail) discard;
    `);
  };
  material.customProgramCacheKey = () => 'vana-tree-impostor-v2';
  return material;
}
