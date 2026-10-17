import * as THREE from 'three';

/**
 * The limb under each climber resting up a crown (presentation only). The observer's lens fades
 * the leaves round a followed animal, and with them the tree's own limbs, so a mangabey sat in
 * the air over a floor 26 m below. Each resting climber is drawn on a limb from its tree's trunk
 * out past where it sits, in one draw call; the lens never fades it, as it never fades animals.
 */
export class CrownLimbs {
  readonly mesh: THREE.InstancedMesh;
  static readonly MAX = 1024;
  readonly #m = new THREE.Matrix4();
  readonly #q = new THREE.Quaternion();
  readonly #from = new THREE.Vector3();
  readonly #to = new THREE.Vector3();
  readonly #along = new THREE.Vector3();
  readonly #scale = new THREE.Vector3();
  static readonly #AXIS = new THREE.Vector3(0, 0, 1);
  #count = 0;

  constructor() {
    // A unit limb along +z from its base (thick, at the trunk) to its tip.
    const geometry = new THREE.CylinderGeometry(0.4, 1, 1, 7, 1);
    geometry.translate(0, 0.5, 0); geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 0.95 });
    this.mesh = new THREE.InstancedMesh(geometry, material, CrownLimbs.MAX);
    this.mesh.name = 'crown-limbs'; this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
  }

  begin(): void { this.#count = 0; }

  /** A limb from the trunk at (trunkX, trunkZ) to just past a climber sitting at (x, feetY, z). */
  add(trunkX: number, trunkZ: number, x: number, feetY: number, z: number): void {
    if (this.#count >= CrownLimbs.MAX) return;
    const out = Math.hypot(x - trunkX, z - trunkZ);
    if (out < 0.2) return;
    const radius = 0.11;
    // From the trunk, a little lower, rising gently out past the animal's feet by most of a metre.
    this.#from.set(trunkX, feetY - radius - 0.35, trunkZ);
    this.#to.set(x + (x - trunkX) / out * 0.9, feetY - radius + 0.05, z + (z - trunkZ) / out * 0.9);
    this.#along.subVectors(this.#to, this.#from);
    const length = this.#along.length();
    this.#q.setFromUnitVectors(CrownLimbs.#AXIS, this.#along.divideScalar(length));
    this.#m.compose(this.#from, this.#q, this.#scale.set(radius, radius, length));
    this.mesh.setMatrixAt(this.#count++, this.#m);
  }

  end(): void {
    this.mesh.count = this.#count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
