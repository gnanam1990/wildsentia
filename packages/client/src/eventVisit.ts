import * as THREE from 'three';
import type { MapMarker } from './eventMap.js';

export function eventVisitDescription(marker: MapMarker): string {
  const day = Math.floor(marker.worldTime / 86_400) + 1;
  const precision = marker.precision === 'patch' ? 'Approximate patch area' : 'Recorded event point';
  const history = marker.type === 'died' || marker.type === 'human_died'
    ? 'This marks the recorded death; remains may already be consumed or decomposed.'
    : 'This is a past event, not a live alert or a current subject location.';
  return `${precision} · world day ${day}. ${history}`;
}

/** A viewer-only historical beacon. It never becomes an animal, carcass or reward target. */
export class EventVisit {
  readonly #root = new THREE.Group();
  readonly #ring: THREE.Mesh;
  readonly #material = new THREE.MeshBasicMaterial({ color: 0xe0ad63, transparent: true,
    opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  readonly #card = document.querySelector<HTMLElement>('#event-visit')!;
  readonly #title = document.querySelector<HTMLElement>('#event-visit-title')!;
  readonly #detail = document.querySelector<HTMLElement>('#event-visit-detail')!;

  constructor(scene: THREE.Scene, openMap: () => void) {
    this.#root.name = 'recorded-event-beacon'; this.#root.visible = false;
    this.#ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.1, 40), this.#material);
    this.#ring.rotation.x = -Math.PI / 2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.4, 6), this.#material);
    stem.position.y = 1.2;
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), this.#material);
    top.position.y = 2.5;
    for (const mesh of [this.#ring, stem, top]) mesh.renderOrder = 8;
    this.#root.add(this.#ring, stem, top); scene.add(this.#root);
    document.querySelector<HTMLButtonElement>('#event-visit-map')!.onclick = openMap;
    document.querySelector<HTMLButtonElement>('#event-visit-clear')!.onclick = () => this.clear();
  }

  show(marker: MapMarker, groundAt: (x: number, z: number) => number): void {
    if (![marker.position.x, marker.position.z, marker.worldTime].every(Number.isFinite)) return;
    const y = groundAt(marker.position.x, marker.position.z);
    if (!Number.isFinite(y)) return;
    const color = marker.type === 'born' || marker.type === 'human_born' ? 0x7fc98a
      : marker.type === 'died' || marker.type === 'human_died' ? 0xe0ad63 : 0x84c8dc;
    this.#material.color.setHex(color);
    this.#ring.scale.setScalar(marker.precision === 'patch' ? 8 : 1);
    this.#root.position.set(marker.position.x, y + 0.05, marker.position.z);
    this.#root.visible = true;
    this.#title.textContent = `${marker.label} · ${marker.actorId ?? 'unknown subject'}`;
    this.#detail.textContent = eventVisitDescription(marker);
    this.#card.hidden = false;
  }

  clear(): void { this.#root.visible = false; this.#card.hidden = true; }
}
