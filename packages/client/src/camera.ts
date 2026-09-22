import * as THREE from 'three';

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

  #manualAt = -Infinity;
  #dragging: 'rotate' | 'pan' | null = null;
  #lastX = 0;
  #lastY = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, element: HTMLElement) {
    element.addEventListener('mousedown', (e) => {
      this.#dragging = e.button === 2 ? 'pan' : 'rotate';
      this.#lastX = e.clientX;
      this.#lastY = e.clientY;
    });
    addEventListener('mouseup', () => { this.#dragging = null; });
    element.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    addEventListener('mousemove', (e) => {
      if (this.#dragging === null) return;
      const dx = e.clientX - this.#lastX;
      const dy = e.clientY - this.#lastY;
      this.#lastX = e.clientX;
      this.#lastY = e.clientY;
      if (this.#dragging === 'rotate') {
        this.theta -= dx * 0.005;
        this.phi = Math.min(1.45, Math.max(0.08, this.phi - dy * 0.004));
        this.#manualAt = performance.now();
      }
    });
    element.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.min(1500, Math.max(6, this.distance * (1 + e.deltaY * 0.0012)));
    }, { passive: false });
  }

  follow(
    position: { x: number; z: number; heading: number; moving: boolean; y?: number },
    dt: number,
  ): void {
    this.target.lerp(
      new THREE.Vector3(position.x, (position.y ?? 0) + 1.2, position.z),
      Math.min(1, dt * 3),
    );

    if (position.moving && performance.now() - this.#manualAt > 3500) {
      const want = position.heading + Math.PI;
      const diff = ((want - this.theta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.theta += diff * Math.min(1, dt * 0.5);
    }
    this.#apply();
  }

  freeLook(dt: number): void {
    void dt;
    this.#apply();
  }

  #apply(): void {
    const cosPhi = Math.cos(this.phi);
    this.camera.position.set(
      this.target.x + Math.sin(this.theta) * cosPhi * this.distance,
      this.target.y + Math.max(Math.sin(this.phi) * this.distance, 1.5),
      this.target.z + Math.cos(this.theta) * cosPhi * this.distance,
    );
    this.camera.lookAt(this.target);
  }
}
