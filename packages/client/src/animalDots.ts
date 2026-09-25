import * as THREE from 'three';
import type { AnimalState } from './protocol.js';
import { renderBaseY, type RenderPosition } from './space.js';
import { visualFor } from './species.js';

interface DotSlot { id: string; species: string; x: number; z: number; altitude: number }

/** Keep unconsumed writes when a renderer hasn't uploaded yet. One bounded dirty span per
 * attribute avoids accumulating thousands of ranges during culling or source-level tests. */
function dirty(attribute: THREE.BufferAttribute, first: number, last: number): void {
  if (last < first) return;
  for (const range of attribute.updateRanges) {
    first = Math.min(first, range.start); last = Math.max(last, range.start + range.count - 1);
  }
  attribute.clearUpdateRanges(); attribute.addUpdateRange(first, last - first + 1);
  attribute.needsUpdate = true;
}

/** One selectable distant-animal draw. Stable dots reuse terrain heights, colours and GPU
 * buffers; changing poses still update every rendered frame, with no movement throttling. */
export class AnimalDots {
  readonly mesh: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  readonly #positions: THREE.BufferAttribute;
  readonly #colours: THREE.BufferAttribute;
  readonly #slots: DotSlot[] = [];
  readonly #colour = new THREE.Color();
  #groundAt: ((x: number, z: number) => number) | null = null;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid animal dot capacity');
    this.#positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.#colours = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.#positions); geometry.setAttribute('color', this.#colours);
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, vertexColors: true, depthWrite: false,
    }));
    this.mesh.name = 'animal-dots'; this.mesh.frustumCulled = false;
  }

  idAt(index: number): string | undefined {
    return Number.isInteger(index) && index >= 0 && index < this.mesh.geometry.drawRange.count ? this.#slots[index]?.id : undefined;
  }
  hide(): void { this.mesh.geometry.setDrawRange(0, 0); }

  sync(animals: ReadonlyMap<string, AnimalState>, positions: ReadonlyMap<string, RenderPosition>,
    modelled: ReadonlySet<string>, groundAt: (x: number, z: number) => number): void {
    const groundChanged = this.#groundAt !== groundAt; this.#groundAt = groundAt;
    let n = 0, positionFirst = Infinity, positionLast = -1, colourFirst = Infinity, colourLast = -1;
    for (const [id, position] of positions) {
      if (modelled.has(id)) continue;
      if (n === this.capacity) break;
      const animal = animals.get(id);
      if (!animal) continue;
      const prior = this.#slots[n], species = animal.speciesId;
      const speciesChanged = !prior || prior.species !== species;
      const altitude = position.altitudeM ?? 0;
      const positionChanged = groundChanged || !prior || prior.x !== position.x || prior.z !== position.z
        || prior.altitude !== altitude || speciesChanged;
      if (positionChanged) {
        this.#positions.setXYZ(n, position.x, renderBaseY(position, groundAt) + visualFor(species).heightM, position.z);
        positionFirst = Math.min(positionFirst, n * 3); positionLast = n * 3 + 2;
      }
      if (speciesChanged) {
        this.#colour.setHex(visualFor(species).colour);
        this.#colours.setXYZ(n, this.#colour.r, this.#colour.g, this.#colour.b);
        colourFirst = Math.min(colourFirst, n * 3); colourLast = n * 3 + 2;
      }
      if (prior) { prior.id = id; prior.species = species; prior.x = position.x; prior.z = position.z; prior.altitude = altitude; }
      else this.#slots.push({ id, species, x: position.x, z: position.z, altitude });
      n++;
    }
    this.#slots.length = n;
    this.mesh.geometry.setDrawRange(0, n);
    dirty(this.#positions, positionFirst, positionLast); dirty(this.#colours, colourFirst, colourLast);
  }
}
