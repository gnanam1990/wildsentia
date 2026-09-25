import * as THREE from 'three';
import { microCounts, type MicroEcologyState } from '@vana/shared';
import { patchCentre } from './space.js';
import type { HeightSampler, PatchView } from './terrain.js';

const ROLES = [
  ['ants', 0xd6a45d, 0.05, 0.02],
  ['pollinators', 0xf2d15d, -0.03, 0.03],
  ['detritivores', 0x9a6e52, 0.03, -0.03],
  ['fish', 0x66b9d0, 0, 0],
] as const;

/** A tiny anti-aliased dot, not a camera-facing square scaled in world metres. */
function markerTexture(): THREE.DataTexture {
  const side = 16;
  const pixels = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const offset = (y * side + x) * 4;
    const coverage = THREE.MathUtils.clamp(7 - Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2), 0, 1);
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
    pixels[offset + 3] = Math.round(coverage * 255);
  }
  const texture = new THREE.DataTexture(pixels, side, side, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Cheap representative dots for population-level organisms; no tiny individual agents are spawned. */
export class MicroEcologyLayer {
  readonly root = new THREE.Group();
  readonly #mesh: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly #markerTexture = markerTexture();
  readonly #positions = new THREE.BufferAttribute(new Float32Array(0), 3);
  readonly #colours = new THREE.BufferAttribute(new Float32Array(0), 3);
  readonly #colour = new THREE.Color();

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.#positions);
    geometry.setAttribute('color', this.#colours);
    this.#mesh = new THREE.Points(geometry, new THREE.PointsMaterial({
      map: this.#markerTexture, size: 4, sizeAttenuation: false,
      vertexColors: true, transparent: true, opacity: 0.82, depthWrite: false,
    }));
    this.#mesh.name = 'micro-ecology';
    this.#mesh.frustumCulled = false;
    this.root.add(this.#mesh);
  }

  sync(state: MicroEcologyState | undefined, patches: readonly PatchView[], groundAt: HeightSampler): void {
    if (!state) { this.root.visible = false; this.#mesh.geometry.setDrawRange(0, 0); return; }
    const byId = new Map(patches.map((p) => [p.id, p]));
    const rows: Array<{ x: number; y: number; z: number; colour: number }> = [];
    for (const population of state.patches) {
      const patch = byId.get(population.patchId);
      if (!patch || patch.surface === 'ocean') continue;
      const centre = patchCentre(patch.id);
      const counts = microCounts(population);
      for (const [role, colour, ox, oz] of ROLES) {
        if (counts[role] <= 0) continue;
        rows.push({ x: centre.x + ox, y: groundAt(centre.x + ox, centre.z + oz) + (role === 'fish' ? 0.12 : 0.35),
          z: centre.z + oz, colour });
      }
    }
    const positions = new Float32Array(rows.length * 3), colours = new Float32Array(rows.length * 3);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, p = i * 3;
      positions[p] = row.x; positions[p + 1] = row.y; positions[p + 2] = row.z;
      this.#colour.setHex(row.colour); colours[p] = this.#colour.r; colours[p + 1] = this.#colour.g; colours[p + 2] = this.#colour.b;
    }
    this.#mesh.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.#mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.#mesh.geometry.setDrawRange(0, rows.length);
    this.root.visible = rows.length > 0;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    this.#mesh.material.dispose();
    this.#markerTexture.dispose();
  }
}
