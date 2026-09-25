import * as THREE from 'three';
import { FOREST_RADIUS_M, treeImpostorMaterial, type TreeAtlas } from './treeLod.js';

export const FOREST_CELL_M = 600;
export interface ForestPlacement { x: number; y: number; z: number; rotY: number; scale: number }
const EMPTY: readonly ForestPlacement[] = [];
interface Cell { items: readonly ForestPlacement[]; mesh: THREE.InstancedMesh }

/** Static, spatially bounded billboard batches. Camera motion never refills instance buffers.
 * Bounds include the shader-expanded, camera-facing square, not the tiny source plane. */
export class ForestBatches {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshBasicMaterial;
  readonly #geometry = new THREE.PlaneGeometry(1, 1);
  readonly #cells = new Map<string, Cell>();
  #items: readonly ForestPlacement[] = EMPTY;
  #disposed = false;

  constructor(private readonly atlas: TreeAtlas, name: string,
    fadeRange?: { value: THREE.Vector2 }) {
    this.root.name = `forest-lod:${name}`;
    this.material = treeImpostorMaterial(atlas, fadeRange);
    // Keep the shared material discoverable for observer-cutaway hooks before first placement.
    const anchor = new THREE.InstancedMesh(this.#geometry, this.material, 1);
    anchor.count = 0; anchor.name = 'material-anchor'; this.root.add(anchor);
  }

  setItems(items: readonly ForestPlacement[] = EMPTY): void {
    if (this.#disposed || items === this.#items) return;
    this.#items = items;
    const groups = new Map<string, ForestPlacement[]>();
    for (const item of items) {
      const key = `${Math.floor(item.x / FOREST_CELL_M)},${Math.floor(item.z / FOREST_CELL_M)}`;
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push(item);
    }
    for (const [key, cell] of this.#cells) if (!groups.has(key)) {
      this.root.remove(cell.mesh); cell.mesh.dispose(); this.#cells.delete(key);
    }
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const position = new THREE.Vector3(), scale = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const centre = new THREE.Vector3(), extent = new THREE.Vector3();
    for (const [key, group] of groups) {
      let cell = this.#cells.get(key);
      if (cell && cell.items.length === group.length && group.every((item, i) => item === cell!.items[i])) continue;
      if (!cell || cell.mesh.instanceMatrix.count < group.length) {
        if (cell) { this.root.remove(cell.mesh); cell.mesh.dispose(); }
        const mesh = new THREE.InstancedMesh(this.#geometry, this.material, 2 ** Math.ceil(Math.log2(group.length)));
        mesh.name = `${this.root.name}:${key}`;
        cell = { items: group, mesh }; this.#cells.set(key, cell); this.root.add(mesh);
      }
      cell.items = group;
      const box = new THREE.Box3();
      group.forEach((item, i) => {
        rotation.setFromAxisAngle(up, item.rotY);
        matrix.compose(position.set(item.x, item.y, item.z), rotation, scale.setScalar(item.scale));
        cell!.mesh.setMatrixAt(i, matrix);
        // Match Float32 GPU transforms, including rotated/off-centre atlas origins.
        cell!.mesh.getMatrixAt(i, matrix);
        centre.copy(this.atlas.centre).applyMatrix4(matrix);
        const radius = this.atlas.diameter * Math.hypot(matrix.elements[0]!, matrix.elements[1]!, matrix.elements[2]!) / Math.SQRT2 + 0.01;
        extent.setScalar(radius);
        box.expandByPoint(position.copy(centre).sub(extent));
        box.expandByPoint(position.copy(centre).add(extent));
      });
      cell.mesh.boundingBox = box;
      cell.mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      cell.mesh.count = group.length; cell.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  updateRange(focus: { x: number; z: number }): void {
    for (const { mesh } of this.#cells.values()) {
      const box = mesh.boundingBox!;
      const dx = Math.max(box.min.x - focus.x, 0, focus.x - box.max.x);
      const dz = Math.max(box.min.z - focus.z, 0, focus.z - box.max.z);
      // Whole crowns retained through the fog horizon. Native frustum culling handles turns.
      mesh.visible = dx * dx + dz * dz <= FOREST_RADIUS_M ** 2;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const mesh of this.root.children) (mesh as THREE.InstancedMesh).dispose();
    this.#geometry.dispose(); this.material.dispose(); this.root.clear(); this.#cells.clear(); this.#items = EMPTY;
    // The shared atlas target remains owned by NearVegetation.
  }
}
