import * as THREE from 'three';

/** Observer framing only. The elephant needs a closer adult-body view than the generic
 * small-animal rule; this never changes its authoritative position or movement. */
export function followDistanceFor(speciesId: string, heightM: number): number {
  return Math.max(2.5, Math.min(22, heightM * (speciesId === 'elephant' ? 5 : 9)));
}


/**
 * A damped orbit camera that can lock onto an animal. When following, it eases behind the
 * animal's heading so travel reads as forward motion instead of the world sliding sideways.
 * Manual dragging suspends that alignment for a few seconds so the viewer stays in control.
 */
export class FollowCamera {
  theta = 0.9;
  phi = 0.55;
  distance = 22;

  readonly target = new THREE.Vector3();
  groundHeightAt: ((x: number, z: number) => number) | null = null;
  reducedMotion = false;
  #terrainLift = 0;

  #manualAt = -Infinity;
  #dragging: 'rotate' | 'pan' | null = null;
  #lastX = 0;
  #lastY = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, element: HTMLElement) {
    element.addEventListener('pointerdown', (e) => {
      this.#dragging = e.button === 2 ? 'pan' : 'rotate';
      this.#lastX = e.clientX;
      this.#lastY = e.clientY;
      element.setPointerCapture(e.pointerId);
    });
    element.addEventListener('pointerup', () => { this.#dragging = null; });
    element.addEventListener('pointercancel', () => { this.#dragging = null; });
    element.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    element.addEventListener('pointermove', (e) => {
      if (this.#dragging === null) return;
      const dx = e.clientX - this.#lastX;
      const dy = e.clientY - this.#lastY;
      this.#lastX = e.clientX;
      this.#lastY = e.clientY;
      if (this.#dragging === 'rotate') {
        this.theta -= dx * 0.005;
        this.phi = Math.min(1.45, Math.max(0.08, this.phi - dy * 0.004));
        this.#manualAt = performance.now();
      } else {
        const step = this.distance * 0.001;
        this.target.x -= (Math.cos(this.theta) * dx + Math.sin(this.theta) * dy) * step;
        this.target.z += (Math.sin(this.theta) * dx - Math.cos(this.theta) * dy) * step;
      }
    });
    element.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.min(1500, Math.max(1, this.distance * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    element.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(e.key)) return;
      e.preventDefault(); this.#manualAt = performance.now();
      if (e.key === 'ArrowLeft') this.theta -= 0.12;
      if (e.key === 'ArrowRight') this.theta += 0.12;
      if (e.key === 'ArrowUp') this.phi = Math.min(1.45, this.phi + 0.08);
      if (e.key === 'ArrowDown') this.phi = Math.max(0.08, this.phi - 0.08);
      if (e.key === '+' || e.key === '=') this.distance = Math.max(1, this.distance / 1.2);
      if (e.key === '-') this.distance = Math.min(1500, this.distance * 1.2);
    });
  }


  follow(
    position: { x: number; z: number; heading: number; moving: boolean; y?: number; focusHeight?: number },
    dt: number,
  ): void {
    this.target.lerp(
      new THREE.Vector3(position.x, (position.y ?? 0) + (position.focusHeight ?? 1.2), position.z),
      Math.min(1, dt * 3),
    );

    if (!this.reducedMotion && position.moving && performance.now() - this.#manualAt > 3500) {
      const want = position.heading + Math.PI;
      const diff = ((want - this.theta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.theta += diff * Math.min(1, dt * 0.5);
    }
    this.#apply(dt);
  }

  freeLook(dt: number): void {
    this.#apply(dt);
  }

  #apply(dt: number): void {
    if (this.groundHeightAt) {
      const floor = this.groundHeightAt(this.target.x, this.target.z);
      if (Number.isFinite(floor)) this.target.y = Math.max(this.target.y, floor + 0.05);
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
