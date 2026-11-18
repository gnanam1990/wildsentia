import * as THREE from 'three';
import { insidePool, type Pool } from './pools.js';
import { poolPlane } from './poolScene.js';

/** A single expanding ring at the watched forest elephant's animated trunk. */
export class DrinkingRipple {
  readonly mesh = new THREE.Mesh(new THREE.RingGeometry(0.91, 1, 40),
    new THREE.MeshBasicMaterial({ color: 0xbac8ad, transparent: true, depthWrite: false }));
  readonly #point = new THREE.Vector3();
  readonly #plane = new THREE.Plane();
  readonly #up = new THREE.Vector3(0, 1, 0);
  #pool: Pool | undefined;
  #ground?: (x: number, z: number) => number;
  readonly #tipIndices = new WeakMap<THREE.BufferGeometry, number>();

  /** Find the end of the hanging trunk on this export once, in its bind pose. */
  #tipIndex(body: THREE.SkinnedMesh): number {
    const cached = this.#tipIndices.get(body.geometry);
    if (cached !== undefined) return cached;
    const bone = body.skeleton.bones.findIndex(b => b.name === 'Bone014');
    const { position, skinIndex, skinWeight } = body.geometry.attributes;
    let tip = -1, lowest = Infinity;
    if (bone >= 0 && position && skinIndex && skinWeight) {
      for (let i = 0; i < position.count; i++) {
        const height = position.getY(i);
        if (height >= lowest) continue;
        for (let k = 0; k < 4; k++) {
          if (skinIndex.getComponent(i, k) === bone && skinWeight.getComponent(i, k) > 0.25) {
            tip = i; lowest = height; break;
          }
        }
      }
    }
    this.#tipIndices.set(body.geometry, tip);
    return tip;
  }

  constructor() {
    this.mesh.name = 'trunk-water-ripple';
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
    this.mesh.raycast = () => {};
  }

  update(body: THREE.SkinnedMesh, phase: number, pools: readonly Pool[], ground: (x: number, z: number) => number): void {
    this.mesh.visible = false;
    if (phase < 0.28 || phase > 0.50) return;
    const tip = this.#tipIndex(body);
    if (tip < 0) return;
    // The last trunk bone carries only part of the tip's skin weight.
    const p = this.#point;
    body.parent?.updateWorldMatrix(true, true);
    body.localToWorld(body.getVertexPosition(tip, p));
    const progress = (phase - 0.28) / 0.22;
    const radius = 0.045 + 0.29 * progress;
    const fits = (pool: Pool) => Math.abs(pool.x - p.x) <= pool.radius * 1.4
      && Math.abs(pool.z - p.z) <= pool.radius * 1.4 && insidePool(pool, p.x, p.z, -radius * 1.2);
    const pool = this.#pool && pools.includes(this.#pool) && fits(this.#pool) ? this.#pool : pools.find(fits);
    if (!pool) return;
    if (this.#pool !== pool || this.#ground !== ground) {
      this.#pool = pool;
      this.#ground = ground;
      this.#plane.set(this.#up, 0).applyMatrix4(poolPlane(pool, ground));
      this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.#plane.normal);
    }
    if (Math.abs(this.#plane.distanceToPoint(p)) > 0.10) return;
    this.#plane.projectPoint(p, this.mesh.position).addScaledVector(this.#plane.normal, 0.008);
    this.mesh.scale.setScalar(radius);
    this.mesh.material.opacity = 0.42 * Math.sin(Math.PI * progress);
    this.mesh.visible = true;
  }
}
