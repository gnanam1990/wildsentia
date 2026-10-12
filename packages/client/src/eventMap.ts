import { GRID_SIZE, PATCH_METRES } from '@vana/shared';
import { islandHeightField } from './islandHeightField.js';
import type { PatchView } from './terrain.js';

export function mapTerrainColour(patch: PatchView, x: number, z: number): string {
  if (patch.islandSeed !== undefined) {
    const height = islandHeightField(patch.islandSeed).sample(x, z);
    if (height <= 0) return '#326077';
    if (height < 6) return '#c4b48d';
  } else if (patch.habitat === 'water' || patch.water > 20_000) return '#326077';
  // A few litres of drinking water do not make an entire forest cell a lake.
  return (patch.canopyCover ?? 0) > .5 ? '#294b37' : '#797855';
}

export interface MapMarker {
  id: string; type: string; worldTime: number; actorId: string | null; actors: string[];
  outcome: string; patchId: number; position: { x: number; z: number }; precision: string; label: string;
}
export function mapMarkerSubject(marker: MapMarker): { kind: 'person' | 'animal'; id: string } | null {
  if (!marker.actorId) return null;
  return { kind: marker.type === 'human_born' || marker.type === 'human_died' ? 'person' : 'animal', id: marker.actorId };
}
/** Only a person's own lifecycle marker links to that person's retained biography. */
export function mapMarkerPersonHistory(marker: MapMarker): string | null {
  return marker.actorId && (marker.type === 'human_born' || marker.type === 'human_died') ? marker.actorId : null;
}
export function mapMarkerGlyph(type: string): string {
  return type === 'hunt' ? 'H' : type === 'human_hunt' ? 'P' : type === 'human_born' ? 'C' : type === 'human_died' ? 'X' : type === 'born' ? 'B' : type === 'immigration' ? 'A' : 'D';
}
export function mapPercent(position: { x: number; z: number }): { left: number; top: number } {
  const span = GRID_SIZE * PATCH_METRES;
  return { left: Math.max(0, Math.min(100, (position.x + PATCH_METRES / 2) / span * 100)),
    top: Math.max(0, Math.min(100, (position.z + PATCH_METRES / 2) / span * 100)) };
}
export class EventMap {
  #markers: MapMarker[] = [];
  #patches: PatchView[] = [];
  #busy = false;
  #worldTime = 0;
  readonly #dialog = document.createElement('dialog');
  readonly #map = document.createElement('div');
  readonly #status = document.createElement('p');
  readonly #list = document.createElement('div');
  readonly #filter = document.createElement('select');
  constructor(private readonly go: (event: MapMarker) => void,
    private readonly watch: (id: string) => void, private readonly replay: (id: string, eventId: string) => void,
    private readonly watchPerson: (id: string) => void, private readonly readPersonHistory: (id: string) => void) {
    this.#dialog.className = 'forest-dialog event-map-dialog'; this.#dialog.setAttribute('aria-labelledby', 'map-title');
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = document.createElement('h2'); title.id = 'map-title'; title.textContent = 'Forest event map';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close map'; close.onclick = () => this.#dialog.close();
    header.append(title, close);
    this.#status.className = 'dialog-status'; this.#status.setAttribute('role', 'status');
    const label = document.createElement('label'); label.className = 'map-filter'; label.textContent = 'Show events ';
    for (const [value, text] of [['all', 'All events'], ['hunt', 'Animal hunts / attacks'], ['human_hunt', 'Human hunts'], ['born', 'Animal births'], ['human_born', 'Human births'], ['died', 'Animal deaths'], ['human_died', 'Human deaths'], ['immigration', 'Animal arrivals']])
      this.#filter.add(new Option(text, value));
    label.append(this.#filter); this.#filter.onchange = () => this.#render();
    this.#map.className = 'forest-map'; this.#map.setAttribute('aria-label', 'Event locations; equivalent actions in the list below');
    this.#list.className = 'map-events';
    const note = document.createElement('p'); note.className = 'dialog-note'; note.textContent = 'Recent recorded events, not live alerts. Visit location moves your camera and marks where the event was recorded; it is not proof that an animal or remains are still there. Follow animal and Watch person use the current saved subject when available. Human birth/death rows can open that person’s retained history. Rewards are never marked on this map.';
    this.#dialog.append(header, label, this.#status, this.#map, note, this.#list); document.body.append(this.#dialog);
    setInterval(() => { if (this.#dialog.open && !document.hidden) void this.refresh(); }, 10_000);
  }
  setPatches(patches: PatchView[]): void { this.#patches = patches; if (this.#dialog.open) this.#render(); }
  open(): void { this.#dialog.showModal(); void this.refresh(); }
  async refresh(): Promise<void> {
    if (this.#busy) return; this.#busy = true;
    this.#status.textContent = 'Loading recorded events…';
    try {
      const response = await fetch('/api/event-map'); if (!response.ok) throw new Error('map unavailable');
      const data = await response.json() as { worldTime: number; markers: MapMarker[] };
      this.#markers = data.markers; this.#worldTime = data.worldTime; this.#render();
      this.#status.textContent = `${data.markers.length} recent events · refreshed ${new Date().toLocaleTimeString()}. H = animal hunt, P = person hunt, B = animal birth, C = human birth, D = animal death, X = human death, A = animal arrival.`;
    } catch { this.#status.textContent = 'Map update unavailable. Any markers below are from the last successful update.'; }
    finally { this.#busy = false; }
  }
  #render(): void {
    // Keep keyboard focus stable during refresh; replace only when focus is outside the dynamic region.
    if (this.#list.contains(document.activeElement) || this.#map.contains(document.activeElement)) return;
    this.#map.replaceChildren(); this.#list.replaceChildren();
    const terrain = document.createElement('canvas'), resolution = this.#patches[0]?.islandSeed === undefined ? GRID_SIZE : 200;
    terrain.width = resolution; terrain.height = resolution;
    terrain.setAttribute('aria-hidden', 'true'); const context = terrain.getContext('2d');
    const byId = new Map(this.#patches.map(p => [p.id, p]));
    if (context) for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
      const p = byId.get(Math.floor(row / resolution * GRID_SIZE) * GRID_SIZE + Math.floor(col / resolution * GRID_SIZE));
      if (!p) continue;
      const x = (col + 0.5) / resolution * GRID_SIZE * PATCH_METRES - PATCH_METRES / 2;
      const z = (row + 0.5) / resolution * GRID_SIZE * PATCH_METRES - PATCH_METRES / 2;
      context.fillStyle = mapTerrainColour(p, x, z);
      context.fillRect(col, row, 1, 1);
    }
    this.#map.append(terrain);
    const markers = this.#markers.filter((m) => this.#filter.value === 'all' || m.type === this.#filter.value);
    if (!markers.length) this.#list.textContent = 'No recorded events in this category yet.';
    for (const m of markers) {
      const button = document.createElement('button'); const pos = mapPercent(m.position);
      button.className = `map-pin map-${m.type}`; button.style.left = `${pos.left}%`; button.style.top = `${pos.top}%`;
      button.textContent = mapMarkerGlyph(m.type);
      button.title = `${m.label} · ${m.actorId ?? 'unknown'} · ${m.precision === 'patch' ? 'approximate patch' : 'recorded location'}`;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => { this.#dialog.close(); this.go(m); };
      this.#map.append(button);
      const row = document.createElement('section'); row.className = 'map-event';
      const heading = document.createElement('h3'); heading.textContent = m.label;
      const actor = document.createElement('p'); actor.className = 'map-event-subject';
      const actorLabel = document.createElement('span'); actorLabel.textContent = 'Subject: ';
      const actorId = document.createElement('code'); actorId.textContent = m.actorId ?? 'unknown'; actor.append(actorLabel, actorId);
      const details = document.createElement('p'); details.className = 'map-event-meta';
      details.textContent = `${Math.max(0, (this.#worldTime - m.worldTime) / 3600).toFixed(1)} world hours ago · ${m.outcome.replaceAll('_', ' ')} · ${m.precision === 'patch' ? 'patch-level location' : 'recorded location'}`;
      const record = document.createElement('p'); record.className = 'map-event-record';
      const recordLabel = document.createElement('span'); recordLabel.textContent = 'Record: ';
      const recordId = document.createElement('code'); recordId.textContent = m.id; record.append(recordLabel, recordId);
      row.append(heading, actor, details);
      if (m.type === 'human_hunt' || m.type === 'human_born') {
        const participants = document.createElement('p'); participants.className = 'map-event-participants';
        participants.textContent = m.type === 'human_hunt' ? `Hunter ${m.actors[0] ?? 'unknown'}`
          : `Child ${m.actors[0] ?? 'unknown'} · parents ${m.actors[1] ?? 'unknown'} and ${m.actors[2] ?? 'unknown'}`;
        row.append(participants);
      }
      const visit = document.createElement('button'); visit.type = 'button'; visit.textContent = 'Visit event location'; visit.onclick = button.onclick;
      row.append(record, visit);
      const subject = mapMarkerSubject(m);
      if (subject) {
        const follow = document.createElement('button'); follow.textContent = subject.kind === 'person' ? 'Watch person' : 'Follow animal / remains';
        follow.onclick = () => { this.#dialog.close(); if (subject.kind === 'person') this.watchPerson(subject.id); else this.watch(subject.id); }; row.append(follow);
        const personHistoryId = mapMarkerPersonHistory(m);
        if (personHistoryId) {
          const history = document.createElement('button'); history.type = 'button'; history.textContent = 'Read person’s retained history';
          history.onclick = () => { this.#dialog.close(); this.readPersonHistory(personHistoryId); }; row.append(history);
        }
        if (m.type === 'hunt') {
          const replay = document.createElement('button'); replay.textContent = 'Open recorded hunt';
          replay.onclick = () => { this.#dialog.close(); this.replay(m.actorId!, m.id); }; row.append(replay);
        }
      }
      this.#list.append(row);
    }
  }
}
