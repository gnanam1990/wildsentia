import * as THREE from 'three';

export interface ObserverSubject { x: number; y: number; z: number; radius: number }
export interface ScreenSubject { x: number; y: number; radius: number; depth: number }
const KEEP = 0.08;
/** Decoration nearer the lens than the first distance (metres) is open, beyond the second whole. */
const LENS_OPEN_M = 0.8, LENS_WHOLE_M = 3.2;
/** Floor plants (patched without the cutaway) open only this share of the lens reach: an ankle-high
 * seedling a metre or two away does not fill the view, and dithered it drew as a net. */
const FLOOR_LENS = 0.4;

/** Same as the shader: how much of a decorative surface this far in front of the lens is drawn
 * (`whole`: the reach beyond which it is whole; the open reach is a quarter of it). */
export function lensKeep(distance: number, whole = LENS_WHOLE_M): number {
  const open = whole === LENS_WHOLE_M ? LENS_OPEN_M : whole / 4;
  const t = Math.max(0, Math.min(1, (distance - open) / (whole - open)));
  return t * t * (3 - 2 * t);
}

/** Fade only decorative instances whose anchor crowds the observer lens. Horizontal
 * distance matters: a camera 8 m above a root can still sit inside its canopy. */
export function cameraInteriorKeep(horizontalDistance: number, scale: number, kind: 'tree' | 'rock'): number {
  // The 8 m broadleaf derivatives have crowns far wider than their root. A lens can
  // be 10 m from the trunk yet still sit inside a 2x-scale canopy; fade that local
  // decorative volume, not the animal or the rest of the forest.
  const start = Math.max(kind === 'tree' ? 5 : 2, scale * (kind === 'tree' ? 3 : 1.4));
  const end = Math.max(kind === 'tree' ? 18 : 5, scale * (kind === 'tree' ? 7 : 2.7));
  const t = Math.max(0, Math.min(1, (horizontalDistance - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/** One dithered, depth-writing camera-interior fade for near instanced trees/large rocks.
 * It is view-only; the same shader also runs for their shadow material. */
export function addCameraInteriorFade(material: THREE.Material, observer: { value: THREE.Vector3 }, kind: 'tree' | 'rock'): void {
  const previous = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  const start = kind === 'tree' ? '5.0' : '2.0', end = kind === 'tree' ? '18.0' : '5.0';
  const startScale = kind === 'tree' ? '3.0' : '1.4', endScale = kind === 'tree' ? '7.0' : '2.7';
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.uniforms.cameraInteriorObserver = observer;
    shader.vertexShader = 'uniform vec3 cameraInteriorObserver; varying float vCameraInteriorDistance; varying float vCameraInteriorScale;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vec4 interiorOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      vCameraInteriorDistance = distance(interiorOrigin.xz, cameraInteriorObserver.xz);
      vCameraInteriorScale = length(instanceMatrix[0].xyz);
    `);
    shader.fragmentShader = 'varying float vCameraInteriorDistance; varying float vCameraInteriorScale;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
      #include <alphatest_fragment>
      float interiorStart = max(${start}, vCameraInteriorScale * ${startScale});
      float interiorEnd = max(${end}, vCameraInteriorScale * ${endScale});
      float interiorKeep = smoothstep(interiorStart, interiorEnd, vCameraInteriorDistance);
      float interiorNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (interiorNoise >= interiorKeep) discard;
    `);
  };
  material.customProgramCacheKey = () => `${key}:camera-interior-${kind}-v2`;
  material.needsUpdate = true;
}

/** Same mask as the shader; coordinates are drawing-buffer pixels, bottom-left origin. */
export function cutawayVisibility(point: { x: number; y: number; depth: number }, subjects: readonly ScreenSubject[]): number {
  let keep = 1;
  for (const subject of subjects.slice(0, 2)) {
    if (subject.radius <= 0 || point.depth >= subject.depth) continue;
    const ratio = Math.hypot(point.x - subject.x, point.y - subject.y) / subject.radius;
    const t = Math.max(0, Math.min(1, (ratio - 0.6) / 0.4));
    keep = Math.min(keep, KEEP + (1 - KEEP) * t * t * (3 - 2 * t));
  }
  return keep;
}

export function projectObserverSubjects(camera: THREE.PerspectiveCamera, size: { x: number; y: number }, subjects: readonly ObserverSubject[]): ScreenSubject[] {
  if (![size.x, size.y].every(Number.isFinite) || size.x <= 0 || size.y <= 0) return [];
  camera.updateMatrixWorld();
  const result: ScreenSubject[] = [];
  for (const subject of subjects.slice(0, 2)) {
    if (![subject.x, subject.y, subject.z, subject.radius].every(Number.isFinite) || subject.radius <= 0) continue;
    const view = new THREE.Vector3(subject.x, subject.y, subject.z).applyMatrix4(camera.matrixWorldInverse);
    if (-view.z <= camera.near) continue;
    const radius = Math.min(Math.min(size.x, size.y) * 0.4,
      Math.max(12, subject.radius * camera.projectionMatrix.elements[5]! * size.y / (-2 * view.z)));
    const point = view.applyMatrix4(camera.projectionMatrix);
    if (point.z < -1 || point.z > 1) continue;
    const x = (point.x + 1) * size.x / 2, y = (point.y + 1) * size.y / 2;
    if (x < -radius || x > size.x + radius || y < -radius || y > size.y + radius) continue;
    result.push({ x, y, radius, depth: (point.z + 1) / 2 });
  }
  return result;
}

/** Viewer-only cutaway. Attach to decorative colour materials, never animals, terrain,
 * water, shadow/depth materials, source meshes used to bake atlases, or simulation state. */
export class ObserverVisibility {
  readonly #attached = new WeakSet<THREE.Material>();
  readonly #subjects = { value: [new THREE.Vector4(), new THREE.Vector4()] };
  readonly #count = { value: 0 };
  /** The lens fade's open and whole reach (metres). */
  readonly #lens = { value: new THREE.Vector2(LENS_OPEN_M, LENS_WHOLE_M) };

  /** Widens the lens fade (a camera among a tree's leaves, following an animal up there); 3.2 m by default. */
  setLensReach(wholeM: number): void {
    const whole = Math.max(LENS_WHOLE_M, wholeM);
    this.#lens.value.set(whole === LENS_WHOLE_M ? LENS_OPEN_M : whole / 4, whole);
  }

  update(camera: THREE.PerspectiveCamera, size: { x: number; y: number }, subjects: readonly ObserverSubject[]): void {
    const projected = projectObserverSubjects(camera, size, subjects);
    this.#count.value = projected.length;
    projected.forEach((s, i) => this.#subjects.value[i]!.set(s.x, s.y, s.radius, s.depth));
  }

  attach(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.patch(material);
    });
  }

  /**
   * `cutaway: false` keeps only the lens fade, at 40% of its reach: for ankle-high floor plants,
   * which hide little of an animal and drew as a dithered net over the ground in front of it.
   */
  patch(material: THREE.Material, options: { cutaway?: boolean } = {}): void {
    const cutaway = options.cutaway ?? true;
    if (this.#attached.has(material)) return;
    this.#attached.add(material);
    const previous = material.onBeforeCompile.bind(material);
    const key = material.customProgramCacheKey();
    material.onBeforeCompile = (shader, renderer) => {
      previous(shader, renderer);
      shader.uniforms.observerSubjects = this.#subjects;
      shader.uniforms.observerSubjectCount = this.#count;
      shader.uniforms.observerLens = this.#lens;
      // A leaf pressed against the lens (the camera following an animal through the understory)
      // opens rather than filling the view.
      // Read from the projected position after every other hook (a far-tree card projects itself);
      // a shader without the fog step keeps every pixel.
      const lens = shader.vertexShader.includes('#include <fog_vertex>');
      if (lens) shader.vertexShader = 'varying float vObserverLens;\n' + shader.vertexShader.replace('#include <fog_vertex>',
        '#include <fog_vertex>\nvObserverLens = gl_Position.w;');
      shader.fragmentShader = `uniform vec4 observerSubjects[2]; uniform int observerSubjectCount;${lens ? ' uniform vec2 observerLens; varying float vObserverLens;' : ''}\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
        #include <alphatest_fragment>
        float observerKeep = 1.0;
        for (int subjectIndex = 0; subjectIndex < ${cutaway ? 2 : 0}; subjectIndex++) {
          if (subjectIndex >= observerSubjectCount) break;
          vec4 subject = observerSubjects[subjectIndex];
          if (gl_FragCoord.z < subject.w) {
            float radiusRatio = distance(gl_FragCoord.xy, subject.xy) / subject.z;
            observerKeep = min(observerKeep, mix(${KEEP.toFixed(2)}, 1.0, smoothstep(0.6, 1.0, radiusRatio)));
          }
        }
        // Correlated screen-space dither leaves the same pixels open through several
        // overlapping branches. No animated noise, transparent sorting or extra draw pass.
        float observerNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (observerNoise >= observerKeep) discard;
        ${lens ? `float observerLensKeep = smoothstep(observerLens.x * ${cutaway ? '1.0' : FLOOR_LENS.toFixed(2)}, observerLens.y * ${cutaway ? '1.0' : FLOOR_LENS.toFixed(2)}, vObserverLens);
        if (observerNoise >= observerLensKeep) discard;` : ''}
      `);
    };
    material.customProgramCacheKey = () => `${key}:observer-cutaway-v3${cutaway ? '' : '-lens-only'}`;
    material.needsUpdate = true;
  }
}
