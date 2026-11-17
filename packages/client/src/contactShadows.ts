import * as THREE from 'three';

/**
 * A soft dark patch under each animal standing on the ground, where its body meets the floor.
 * Under a closed canopy the sun's shadow map has little to say (the trees already shade the
 * floor), so without it an animal reads as pasted on. One instanced mesh draws every patch.
 */
export interface ContactSpot {
  x: number;
  y: number;
  z: number;
  /** Nose-to-tail length and the heading it faces, radians (as the animal's group). */
  lengthM: number;
  heading: number;
}

/** How dark the centre of a patch is, and how far past the body it reaches. */
export const CONTACT_OPACITY = 0.42;
const WIDTH_OF_LENGTH = 0.55, REACH = 1.25;

function gradientTexture(): THREE.Texture {
  const size = 64;
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const fill = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  fill.addColorStop(0, 'rgba(0,0,0,1)'); fill.addColorStop(0.45, 'rgba(0,0,0,.55)'); fill.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fill; g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export class ContactShadows {
  readonly mesh: THREE.InstancedMesh;
  readonly #matrix = new THREE.Matrix4();
  readonly #rotation = new THREE.Quaternion();
  readonly #scale = new THREE.Vector3();
  readonly #position = new THREE.Vector3();
  static readonly #flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  static readonly #up = new THREE.Vector3(0, 1, 0);

  constructor(readonly capacity = 512) {
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: gradientTexture(), transparent: true,
      opacity: CONTACT_OPACITY, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, capacity);
    this.mesh.name = 'contact-shadows';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Never a target for "tap an animal": the raycast walks the animal layer's children.
    this.mesh.raycast = () => {};
  }

  /** Lays one patch per spot (up to capacity), a few millimetres above the ground it was given. */
  update(spots: Iterable<ContactSpot>): void {
    let i = 0;
    for (const spot of spots) {
      if (i >= this.capacity) break;
      const length = Math.max(0.2, spot.lengthM) * REACH;
      this.#rotation.setFromAxisAngle(ContactShadows.#up, spot.heading).multiply(ContactShadows.#flat);
      this.#scale.set(length * WIDTH_OF_LENGTH, length, 1);
      this.#position.set(spot.x, spot.y + 0.02, spot.z);
      this.mesh.setMatrixAt(i++, this.#matrix.compose(this.#position, this.#rotation, this.#scale));
    }
    this.mesh.count = i;
    if (i > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const material = this.mesh.material as THREE.MeshBasicMaterial;
    material.alphaMap?.dispose(); material.dispose();
  }
}
