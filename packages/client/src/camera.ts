import { worldExtentM } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import * as THREE from 'three';


/** Observer framing only. The elephant needs a closer adult-body view than the generic
 * small-animal rule; this never changes its authoritative position or movement. */
const DEFAULT_THETA = 0.9;
const DEFAULT_PHI = 0.55;
/** How long a viewer's own camera angle is kept before it drifts back behind a moving animal. */
export const MANUAL_HOLD_MS = 10_000;

export function followDistanceFor(speciesId: string, heightM: number): number {
  return Math.max(2.5, Math.min(22, heightM * (speciesId === 'elephant' ? 5 : 9)));
}

export const MIN_DISTANCE = 1;
/** Far enough to take in the whole island from above. */
export const MAX_DISTANCE = 5000;

/** Keeps an explored point over the island, with a margin so its coast stays in view. */
export function clampToIsland(target: THREE.Vector3, margin = worldGrid().patchM): THREE.Vector3 {
  // The world's ground, from the first patch's west edge to the last patch's east edge.
  const e = worldExtentM(worldGrid());
  target.x = Math.min(e.maxX + margin, Math.max(e.min - margin, target.x));
  target.z = Math.min(e.maxZ + margin, Math.max(e.min - margin, target.z));
  return target;
}

/**
 * Where the viewer looks, for the server's region and agent streaming: the followed animal when
 * there is one (Congo 1A.4: the camera may still be gliding toward it from far away), else the
 * camera's ground point. The radius grows with zoom, from 300 m to 1.5 km.
 */
export function viewMessage(target: { x: number; z: number }, distance: number, followed: { x: number; z: number } | null):
  { x: number; z: number; radius: number } {
  const at = followed ?? target;
  return { x: Math.round(at.x), z: Math.round(at.z), radius: Math.round(Math.min(1500, Math.max(300, distance * 2.5 + 200))) };
}

/**
 * Ground metres moved by a screen drag, so the point under the cursor stays under it.
 * `theta` is the orbit angle: the camera sits at +(sin θ, cos θ) from the target and looks back.
 */
export function groundPan(
  theta: number, phi: number, distance: number, fovDeg: number, viewportHeight: number, dx: number, dy: number,
): { x: number; z: number } {
  const metresPerPixel = 2 * distance * Math.tan(fovDeg * Math.PI / 360) / Math.max(1, viewportHeight);
  // A vertical drag covers more ground the flatter the view is.
  const forwardPerPixel = metresPerPixel / Math.max(0.35, Math.sin(phi));
  const right = { x: Math.cos(theta), z: -Math.sin(theta) };
  const forward = { x: -Math.sin(theta), z: -Math.cos(theta) };
  return {
    x: -right.x * dx * metresPerPixel + forward.x * dy * forwardPerPixel,
    z: -right.z * dx * metresPerPixel + forward.z * dy * forwardPerPixel,
  };
}

interface Pointer { x: number; y: number }

/**
 * The observer's camera. It either follows an animal, easing behind its heading so travel reads
 * as forward motion, or explores the island freely like a map: drag to pan, right- or
 * shift-drag to rotate, scroll to zoom toward the cursor, pinch and twist on touch, WASD to
 * pan. Panning while following hands control back to the viewer through `onExplore`.
 */
export class FollowCamera {
  theta = DEFAULT_THETA;
  phi = DEFAULT_PHI;
  distance = 22;

  readonly target = new THREE.Vector3();
  groundHeightAt: ((x: number, z: number) => number) | null = null;
  reducedMotion = false;
  /** Called when the viewer starts to pan away from whatever is being followed. */
  onExplore: (() => void) | null = null;
  #terrainLift = 0;

  #manualAt = -Infinity;
  readonly #pointers = new Map<number, Pointer>();
  #mode: 'rotate' | 'pan' | null = null;
  #lastX = 0;
  #lastY = 0;
  #pressX = 0;
  #pressY = 0;
  /** A press becomes a pan only after it moves a few pixels, so a click on an animal stays a click. */
  #panStarted = false;
  /** Following an animal (zoom keeps it centred) rather than exploring. */
  #following = false;
  /** Set when two fingers were down during the current touch, so lifting them is not a tap. */
  #multiTouch = false;
  #pinch: { distance: number; angle: number } | null = null;
  /** Ground metres per second, carried on after a pan is released. */
  readonly #velocity = new THREE.Vector2();
  #lastMoveAt = 0;
  readonly #keys = new Set<string>();
  /** A zoom the camera eases toward, e.g. when flying from the island overview to an animal. */
  #distanceGoal: number | null = null;
  /** Set when a new subject is chosen: the next follow cuts to it rather than gliding across the forest. */
  #cutNext = false;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly element: HTMLElement) {
    element.addEventListener('pointerdown', (e) => {
      this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      element.setPointerCapture?.(e.pointerId);
      this.#velocity.set(0, 0);
      if (this.#pointers.size >= 2) {
        this.#multiTouch = true;
        this.#mode = null;
        this.#pinch = this.#twoFinger();
        return;
      }
      this.#multiTouch = false;
      // While following an animal a plain drag circles it, as in most 3D viewers; while
      // exploring it moves over the map. Right/middle button or a modifier always rotates.
      this.#mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.altKey || this.#following ? 'rotate' : 'pan';
      this.#lastX = this.#pressX = e.clientX;
      this.#lastY = this.#pressY = e.clientY;
      this.#panStarted = false;
    });
    const release = (e: PointerEvent) => {
      this.#pointers.delete(e.pointerId);
      if (this.#pointers.size === 1) {
        // One finger of a pinch lifted: carry on panning with the other, without a jump.
        const [rest] = this.#pointers.values();
        this.#mode = 'pan'; this.#lastX = rest!.x; this.#lastY = rest!.y; this.#pinch = null;
        return;
      }
      this.#pinch = null;
      if (this.#mode === 'pan' && (this.reducedMotion || performance.now() - this.#lastMoveAt > 80)) this.#velocity.set(0, 0);
      this.#mode = null;
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', (e) => { release(e); this.#velocity.set(0, 0); this.#pointers.clear(); this.#mode = null; });
    element.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    element.addEventListener('pointermove', (e) => {
      if (this.#pointers.has(e.pointerId)) this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.#pointers.size >= 2) { this.#applyPinch(); return; }
      if (this.#mode === null) return;
      if (!this.#panStarted) {
        if (Math.hypot(e.clientX - this.#pressX, e.clientY - this.#pressY) < 5) return;
        this.#panStarted = true;
      }
      const dx = e.clientX - this.#lastX;
      const dy = e.clientY - this.#lastY;
      this.#lastX = e.clientX;
      this.#lastY = e.clientY;
      if (this.#mode === 'rotate') {
        // As if grabbing the scene, the way other 3D viewers turn: it follows the cursor sideways,
        // and dragging down lifts the view to look from higher (it used to sink toward the ground).
        this.rotateBy(-dx * 0.005);
        this.tiltBy(dy * 0.004);
      } else {
        this.panBy(dx, dy);
      }
    });
    element.addEventListener('wheel', (e) => {
      e.preventDefault();
      // A sideways two-finger swipe on a trackpad turns the view; it has no other meaning here.
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) { this.rotateBy(e.deltaX * 0.004); return; }
      // Trackpad pinch arrives as a ctrl-wheel; both zoom toward the cursor.
      const scale = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012));
      this.zoomAt(this.distance * scale, e.clientX, e.clientY);
    }, { passive: false });
    element.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['w', 'a', 's', 'd'].includes(key)) { e.preventDefault(); this.#keys.add(key); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'q', 'e'].includes(key)) return;
      e.preventDefault();
      if (key === 'ArrowLeft' || key === 'q') this.rotateBy(-0.12);
      if (key === 'ArrowRight' || key === 'e') this.rotateBy(0.12);
      if (key === 'ArrowUp') this.tiltBy(0.08);
      if (key === 'ArrowDown') this.tiltBy(-0.08);
      if (key === '+' || key === '=') this.zoomBy(1 / 1.2);
      if (key === '-') this.zoomBy(1.2);
    });
    element.addEventListener('keyup', (e) => { this.#keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); });
    element.addEventListener('blur', () => { this.#keys.clear(); });
  }

  /** True when the press that just ended was a two-finger gesture, not a tap on an animal. */
  get wasGesture(): boolean {
    return this.#multiTouch;
  }

  /** Turns the view around its centre (radians, positive is clockwise from above). */
  rotateBy(radians: number): void {
    this.theta += radians;
    this.#manualAt = performance.now();
  }

  /** Raises (positive) or lowers the viewing angle, between near the ground and overhead. */
  tiltBy(radians: number): void {
    this.phi = Math.min(1.45, Math.max(0.08, this.phi + radians));
    this.#manualAt = performance.now();
  }

  /** Zooms about the view's centre: below 1 moves in, above 1 moves out. */
  zoomBy(factor: number): void {
    this.#distanceGoal = null;
    this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.distance * factor));
    this.#manualAt = performance.now();
  }

  /** Back to the default viewing angle and distance. */
  resetView(): void {
    this.theta = DEFAULT_THETA; this.phi = DEFAULT_PHI;
    this.#manualAt = -Infinity;
  }

  /** Eases the zoom to `distance` over about a second, so choosing an animal reads as a flight. */
  flyToDistance(distance: number): void {
    this.#distanceGoal = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance));
    if (this.reducedMotion) { this.distance = this.#distanceGoal; this.#distanceGoal = null; }
  }

  /** Moves the explored point by a screen drag of (dx, dy) pixels. */
  panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.onExplore?.();
    const move = groundPan(this.theta, this.phi, this.distance, this.camera.fov, this.#viewportHeight(), dx, dy);
    this.target.x += move.x;
    this.target.z += move.z;
    clampToIsland(this.target);
    const now = performance.now();
    const seconds = Math.max(1 / 240, (now - this.#lastMoveAt) / 1000);
    this.#lastMoveAt = now;
    // Smoothed release velocity, so a flick glides on and stops gently.
    this.#velocity.lerp(new THREE.Vector2(move.x / seconds, move.z / seconds), 0.35);
  }

  /** Zooms to `distance`, keeping the ground under the screen point (x, y) where it was. */
  zoomAt(distance: number, x: number, y: number): void {
    this.#distanceGoal = null;
    const next = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance));
    const anchor = this.#following ? null : this.#groundUnder(x, y);
    if (anchor !== null) {
      const pull = 1 - next / this.distance;
      this.target.x += (anchor.x - this.target.x) * pull;
      this.target.z += (anchor.z - this.target.z) * pull;
      clampToIsland(this.target);
    }
    this.distance = next;
  }

  /**
   * The next follow() cuts straight to its subject at its framing distance, as a film cuts
   * between shots: choosing another animal shows it at once instead of flying over the forest.
   */
  cutToNext(): void { this.#cutNext = true; }
  /** Whether a cut is waiting for the next follow(). */
  get cutPending(): boolean { return this.#cutNext; }

  follow(
    position: { x: number; z: number; heading: number; moving: boolean; y?: number; focusHeight?: number },
    dt: number,
  ): void {
    this.#following = true;
    this.#velocity.set(0, 0);
    const subject = new THREE.Vector3(position.x, (position.y ?? 0) + (position.focusHeight ?? 1.2), position.z);
    if (this.#cutNext) {
      this.#cutNext = false;
      this.target.copy(subject);
      if (this.#distanceGoal !== null) { this.distance = this.#distanceGoal; this.#distanceGoal = null; }
      // Framed from behind it, as a moving animal would settle to anyway.
      this.theta = position.heading + Math.PI;
      this.#terrainLift = 0;
      this.#apply(0);
      return;
    }
    this.target.lerp(subject, Math.min(1, dt * 3));

    // Drift back behind a moving animal only after the viewer has left the view alone a while.
    if (!this.reducedMotion && position.moving && performance.now() - this.#manualAt > MANUAL_HOLD_MS) {
      const want = position.heading + Math.PI;
      const diff = ((want - this.theta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.theta += diff * Math.min(1, dt * 0.5);
    }
    this.#apply(dt);
  }

  /**
   * Keeps following but holds the last framing, for a frame where the followed animal's
   * position is not known. Zoom, turns and flights still apply, so the view never freezes.
   */
  hold(dt: number): void {
    this.#following = true;
    this.#velocity.set(0, 0);
    this.#apply(dt);
  }

  freeLook(dt: number): void {
    this.#following = false;
    const step = Math.max(0, Math.min(dt, 0.1));
    if (this.#keys.size > 0) {
      // Keyboard pan speed scales with height, so crossing the island never takes forever.
      const pixels = this.#viewportHeight() * 0.9 * step;
      const dx = (this.#keys.has('d') ? -1 : 0) + (this.#keys.has('a') ? 1 : 0);
      const dy = (this.#keys.has('w') ? 1 : 0) + (this.#keys.has('s') ? -1 : 0);
      this.panBy(dx * pixels, dy * pixels);
      // Keys stop where they are released; only a flicked drag glides on.
      this.#velocity.set(0, 0);
    } else if (this.#mode !== 'pan' && this.#pointers.size === 0 && this.#velocity.lengthSq() > 0.01) {
      this.target.x += this.#velocity.x * step;
      this.target.z += this.#velocity.y * step;
      clampToIsland(this.target);
      this.#velocity.multiplyScalar(Math.exp(-step * 4));
    }
    this.#apply(dt);
  }

  #viewportHeight(): number {
    return (this.element as HTMLElement).clientHeight || (typeof innerHeight === 'number' ? innerHeight : 800);
  }

  /** Where a screen point meets the horizontal plane through the target. */
  #groundUnder(x: number, y: number): THREE.Vector3 | null {
    const rect = this.element.getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    this.camera.updateMatrixWorld();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.target.y), new THREE.Vector3());
    // A point near the horizon is kilometres away; zooming toward it would fling the view.
    if (hit === null || hit.distanceTo(this.target) > this.distance * 4) return null;
    return hit;
  }

  #twoFinger(): { distance: number; angle: number } {
    const [a, b] = [...this.#pointers.values()];
    return { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), angle: Math.atan2(b!.y - a!.y, b!.x - a!.x) };
  }

  #applyPinch(): void {
    const now = this.#twoFinger();
    const before = this.#pinch;
    this.#pinch = now;
    if (before === null || now.distance < 1 || before.distance < 1) return;
    const [a, b] = [...this.#pointers.values()];
    this.zoomAt(this.distance * (before.distance / now.distance), (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
    const turn = ((now.angle - before.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.theta -= turn;
    this.#manualAt = performance.now();
  }

  #apply(dt: number): void {
    if (this.#distanceGoal !== null) {
      // Ease in log space: a 900 m overview and a 3 m hare close-up take the same time.
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) * 2.5);
      this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.#distanceGoal) - Math.log(this.distance)) * k);
      if (Math.abs(this.distance / this.#distanceGoal - 1) < 0.005) { this.distance = this.#distanceGoal; this.#distanceGoal = null; }
    }
    if (this.groundHeightAt) {
      const floor = this.groundHeightAt(this.target.x, this.target.z);
      if (Number.isFinite(floor)) {
        const lowest = floor + 0.05;
        // Exploring glides down over the ground rather than hovering at an old animal's height.
        this.target.y = this.#following || this.target.y <= lowest ? Math.max(this.target.y, lowest)
          : lowest + (this.target.y - lowest) * Math.exp(-Math.max(0, dt) * 4);
      }
    }
    const cosPhi = Math.cos(this.phi);
    this.camera.position.set(
      this.target.x + Math.sin(this.theta) * cosPhi * this.distance,
      this.target.y + Math.max(Math.sin(this.phi) * this.distance, 1.5),
      this.target.z + Math.cos(this.theta) * cosPhi * this.distance,
    );
    if (this.groundHeightAt) {
      const desired = terrainSafeCameraHeight(this.target, this.camera.position, this.groundHeightAt);
      const requiredLift = desired - this.camera.position.y;
      // Safety correction is immediate. Release gently instead of dropping when a ridge
      // clears; reduced-motion mode skips that automatic easing. Orbit/zoom intent is kept.
      this.#terrainLift = this.reducedMotion ? requiredLift
        : Math.max(requiredLift, this.#terrainLift * Math.exp(-Math.max(0, dt) * 5));
      this.camera.position.y += this.#terrainLift;
    }
    this.camera.lookAt(this.target);
    // The labels over animals are projected before the frame is drawn; without this they used the
    // last frame's camera and shook against a moving view.
    this.camera.updateMatrixWorld();
  }
}

/** Lift the observer, not the landscape or animal. The terrain is a coarse continuous mesh;
 * 64 bounded samples also catch ridges between a clear endpoint and the followed subject.
 * Clearance tapers at the subject so tiny animals near the ground remain valid targets. */
export function terrainSafeCameraHeight(target: THREE.Vector3, desired: THREE.Vector3, groundAt: (x: number, z: number) => number): number {
  const span = Math.hypot(desired.x - target.x, desired.z - target.z);
  let height = desired.y;
  for (let i = 1; i <= 64; i++) {
    const t = i / 64;
    const x = target.x + (desired.x - target.x) * t, z = target.z + (desired.z - target.z) * t;
    const clearance = 0.6 * Math.min(1, t * span / 2);
    const floor = groundAt(x, z);
    if (Number.isFinite(floor)) height = Math.max(height, target.y + (floor + clearance - target.y) / t);
  }
  const endpoint = groundAt(desired.x, desired.z);
  return Number.isFinite(endpoint) ? Math.max(height, endpoint + 0.6) : height;
}
