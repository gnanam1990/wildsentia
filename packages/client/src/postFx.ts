import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { RenderTier } from './renderQuality.js';

/**
 * The observer's finishing pass: the scene drawn once into a multisampled buffer, a faint bloom
 * on what the sun lights brightest, the usual filmic tone mapping, then a gentle documentary
 * grade (a soft contrast curve, warm light and cool shade, a light vignette). Bright by default:
 * the grade lifts the shade a touch rather than crushing it.
 *
 * Smooth graphics skip all of it and draw straight to the screen, as before.
 */

export interface PostFxSettings { bloom: boolean; grade: boolean }

export function postFxFor(tier: RenderTier): PostFxSettings {
  return tier === 'smooth' ? { bloom: false, grade: false } : { bloom: tier === 'high', grade: true };
}

/** The grade's look, kept here so it can be tuned and tested in one place. */
export const GRADE = {
  /** Contrast of the soft S-curve round mid grey (0 = none). */
  contrast: 0.08,
  /** Shade lifted toward this (display units), so the forest floor never goes black. */
  lift: 0.018,
  saturation: 1.06,
  /** Added to the highlights (warm) and the shade (cool), display units. */
  warm: [0.022, 0.012, -0.012] as const,
  cool: [-0.01, 0.004, 0.016] as const,
  vignette: 0.14,
};

export const GradeShader = {
  name: 'WildsentiaGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    contrast: { value: GRADE.contrast },
    lift: { value: GRADE.lift },
    saturation: { value: GRADE.saturation },
    warm: { value: new THREE.Vector3(...GRADE.warm) },
    cool: { value: new THREE.Vector3(...GRADE.cool) },
    vignette: { value: GRADE.vignette },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float contrast, lift, saturation, vignette, aspect;
    uniform vec3 warm, cool;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Split toning: warm where the light falls, cool in the shade.
      c += warm * smoothstep(0.45, 1.0, luma) + cool * (1.0 - smoothstep(0.0, 0.45, luma));
      // A soft S-curve round mid grey, then the shade lifted a touch.
      c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
      c = lift + c * (1.0 - lift);
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, saturation);
      // A light vignette, round on any screen shape.
      vec2 v = (vUv - 0.5) * vec2(aspect, 1.0);
      c *= 1.0 - vignette * smoothstep(0.35, 0.95, length(v));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
    }`,
};

export class PostFx {
  #composer: EffectComposer | null = null;
  #bloom: UnrealBloomPass | null = null;
  #grade: ShaderPass | null = null;
  #settings: PostFxSettings = { bloom: false, grade: false };
  readonly #size = new THREE.Vector2();
  readonly #drawn = new THREE.Vector2(-1, -1);

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {}

  get settings(): PostFxSettings { return this.#settings; }

  setTier(tier: RenderTier): void {
    this.#settings = postFxFor(tier);
    if (this.#composer) {
      this.#bloom!.enabled = this.#settings.bloom;
      this.#grade!.enabled = this.#settings.grade;
    }
  }

  #build(): EffectComposer {
    const size = this.renderer.getDrawingBufferSize(this.#size);
    // Multisampled, half-float: the scene keeps its antialiasing and its highlights above white for the bloom.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.#bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.55, 0.92);
    composer.addPass(this.#bloom);
    composer.addPass(new OutputPass());
    this.#grade = new ShaderPass(GradeShader);
    composer.addPass(this.#grade);
    this.#bloom.enabled = this.#settings.bloom; this.#grade.enabled = this.#settings.grade;
    return composer;
  }

  render(): void {
    if (!this.#settings.bloom && !this.#settings.grade) { this.renderer.render(this.scene, this.camera); return; }
    const composer = this.#composer ??= this.#build();
    const size = this.renderer.getDrawingBufferSize(this.#size);
    if (size.x !== this.#drawn.x || size.y !== this.#drawn.y) {
      this.#drawn.copy(size);
      // The composer sizes its buffers in drawing-buffer pixels; the renderer's own ratio is already in them.
      composer.setPixelRatio(1);
      composer.setSize(size.x, size.y);
      this.#grade!.uniforms.aspect!.value = size.x / Math.max(1, size.y);
    }
    // The frame's draw count is the whole frame's, not the last pass's (the stats overlay reads it).
    const info = this.renderer.info, autoReset = info.autoReset;
    info.autoReset = false; info.reset();
    composer.render();
    info.autoReset = autoReset;
  }

  dispose(): void { this.#composer?.dispose(); this.#composer = null; }
}
