import { congoChannelHalfM, congoRivers } from '@vana/shared';
import { worldGrid } from './worldGrid.js';
import type { PatchView } from './terrain.js';
import { animalTitle, speciesName } from './animalBrowserModel.js';
import { animalsInArea, nearestAnimal, sortForList, speciesColour, speciesCounts, unpackAnimalMap, viewArea, zoomAt,
  type AnimalMapPayload, type MapAnimal, type MapView } from './animalMapModel.js';

/** An animal the viewer can see in the forest now: on screen, in the regions around the view. */
export interface SeenAnimal { id: string; speciesId: string; state: string }

const PAGE = 200;
const HABITAT: Record<string, string> = {
  terra_firme: '#1f3a28', swamp_forest: '#24443a', flooded_forest: '#21403f', bai: '#5d6b3c',
  // A river patch's dry edge is flooded forest; its channel is drawn as the river itself.
  water: '#21403f',
};

/**
 * Every living animal on one map of the forest, and lists of the animals in view: those on the
 * screen in the forest now, or those in the part of the map shown. Drag to move the map, scroll
 * or the buttons to zoom; choosing an animal on the map or in a list follows it, and clicking
 * the map where no animal is takes the camera there.
 */
export class AnimalMap {
  readonly #dialog = document.createElement('dialog');
  readonly #canvas = document.createElement('canvas');
  readonly #status = document.createElement('p');
  readonly #legend = document.createElement('div');
  readonly #list = document.createElement('ul');
  readonly #more = document.createElement('button');
  readonly #listTitle = document.createElement('p');
  readonly #tabs = { seen: document.createElement('button'), area: document.createElement('button') };
  #tab: 'seen' | 'area' = 'seen';
  #animals: MapAnimal[] = [];
  #patches: PatchView[] = [];
  #terrain: HTMLCanvasElement | null = null;
  #rivers: Array<{ half: number; points: Array<{ x: number; z: number }> }> = [];
  readonly #hidden = new Set<string>();
  #view: MapView = { cx: 0, cz: 0, scale: 0.02 };
  #fitted = false;
  #shownRows = PAGE;
  #busy = false;
  #drag: { x: number; z: number; moved: boolean; view: MapView } | null = null;

  constructor(
    private readonly watch: (id: string) => void,
    private readonly go: (x: number, z: number) => void,
    private readonly seen: () => SeenAnimal[],
    private readonly here: () => { x: number; z: number; followedId: string | null },
  ) {
    this.#dialog.className = 'forest-dialog animal-map';
    this.#dialog.setAttribute('aria-labelledby', 'animal-map-title');
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = document.createElement('h2'); title.id = 'animal-map-title'; title.textContent = 'Animal map';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close';
    close.onclick = () => this.#dialog.close();
    header.append(title, close);
    this.#status.className = 'dialog-status'; this.#status.setAttribute('role', 'status');

    const mapBox = document.createElement('div'); mapBox.className = 'animal-map-canvas';
    this.#canvas.setAttribute('aria-label', 'Map of every living animal. Drag to move, scroll to zoom, click an animal to follow it.');
    const tools = document.createElement('div'); tools.className = 'animal-map-tools';
    const button = (text: string, label: string, act: () => void) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.onclick = act; return b;
    };
    tools.append(
      button('+', 'Zoom in', () => this.#zoom(2)),
      button('−', 'Zoom out', () => this.#zoom(0.5)),
      button('Me', 'Centre on the view', () => { const h = this.here(); this.#view = { cx: h.x, cz: h.z, scale: Math.max(this.#view.scale, 0.25) }; this.#changed(); }),
      button('All', 'Whole forest', () => { this.#fit(); this.#changed(); }),
    );
    mapBox.append(this.#canvas, tools);

    const side = document.createElement('div'); side.className = 'animal-map-side';
    const tabBar = document.createElement('div'); tabBar.className = 'animal-map-tabs'; tabBar.setAttribute('role', 'tablist');
    for (const [key, text] of [['seen', 'In my view'], ['area', 'On this map']] as const) {
      const tab = this.#tabs[key]; tab.type = 'button'; tab.textContent = text; tab.setAttribute('role', 'tab');
      tab.onclick = () => { this.#tab = key; this.#shownRows = PAGE; this.#renderList(); };
      tabBar.append(tab);
    }
    this.#listTitle.className = 'animal-map-count';
    this.#list.className = 'animal-browser-list animal-map-list';
    this.#more.type = 'button'; this.#more.textContent = 'Show more'; this.#more.hidden = true;
    this.#more.onclick = () => { this.#shownRows += PAGE; this.#renderList(); };
    this.#legend.className = 'animal-map-legend';
    side.append(this.#legend, tabBar, this.#listTitle, this.#list, this.#more);
    this.#dialog.append(header, this.#status, mapBox, side);

    this.#canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.#canvas.getBoundingClientRect();
      this.#view = zoomAt(this.#view, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, r.width, r.height, this.#minScale(), 2);
      this.#changed();
    }, { passive: false });
    this.#canvas.addEventListener('pointerdown', (e) => {
      this.#canvas.setPointerCapture(e.pointerId);
      this.#drag = { x: e.clientX, z: e.clientY, moved: false, view: { ...this.#view } };
    });
    this.#canvas.addEventListener('pointermove', (e) => {
      if (!this.#drag) return;
      const dx = e.clientX - this.#drag.x, dz = e.clientY - this.#drag.z;
      if (Math.hypot(dx, dz) > 4) this.#drag.moved = true;
      if (!this.#drag.moved) return;
      this.#view = { ...this.#drag.view, cx: this.#drag.view.cx - dx / this.#view.scale, cz: this.#drag.view.cz - dz / this.#view.scale };
      this.#draw();
    });
    this.#canvas.addEventListener('pointerup', (e) => {
      const drag = this.#drag; this.#drag = null;
      if (!drag) return;
      if (drag.moved) { this.#changed(); return; }
      const r = this.#canvas.getBoundingClientRect();
      const x = this.#view.cx + (e.clientX - r.left - r.width / 2) / this.#view.scale;
      const z = this.#view.cz + (e.clientY - r.top - r.height / 2) / this.#view.scale;
      const hit = nearestAnimal(this.#animals, x, z, 8 / this.#view.scale, this.#shown());
      this.#dialog.close();
      if (hit) this.watch(hit.id); else this.go(x, z);
    });
    new ResizeObserver(() => { if (this.#dialog.open) this.#draw(); }).observe(this.#canvas);
    document.body.append(this.#dialog);
    setInterval(() => { if (this.#dialog.open && !document.hidden) void this.refresh(); }, 30_000);
    setInterval(() => { if (this.#dialog.open && !document.hidden && this.#tab === 'seen') this.#renderList(); }, 2_000);
  }

  setPatches(patches: PatchView[]): void {
    this.#patches = patches; this.#terrain = null;
    const seed = patches[0]?.congoSeed;
    this.#rivers = seed === undefined ? [] : congoRivers(seed, worldGrid()).map((r) => ({ half: congoChannelHalfM(r, worldGrid()), points: r.points }));
    if (this.#dialog.open) this.#draw();
  }

  open(): void {
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#tab = 'seen'; this.#shownRows = PAGE;
    if (!this.#fitted) this.#fit();
    this.#draw(); this.#renderList();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.#busy) return; this.#busy = true;
    if (this.#animals.length === 0) this.#status.textContent = 'Loading every animal…';
    try {
      const response = await fetch('/api/animals/map');
      if (!response.ok) throw new Error(String(response.status));
      this.#animals = unpackAnimalMap(await response.json() as AnimalMapPayload);
      this.#status.textContent = `${this.#animals.length.toLocaleString('en-US')} living animals · updated ${new Date().toLocaleTimeString()}`;
      this.#renderLegend(); this.#draw(); this.#renderList();
    } catch { this.#status.textContent = 'The map could not be updated. Any animals shown are from the last update.'; }
    finally { this.#busy = false; }
  }

  #shown(): Set<string> {
    return new Set(speciesCounts(this.#animals).map((s) => s.speciesId).filter((id) => !this.#hidden.has(id)));
  }
  #span(): number { return worldGrid().cols * worldGrid().patchM; }
  #minScale(): number { const r = this.#canvas.getBoundingClientRect(); return Math.min(r.width || 400, r.height || 400) / this.#span() * 0.8; }
  #fit(): void {
    const r = this.#canvas.getBoundingClientRect(), span = this.#span(), origin = -worldGrid().patchM / 2;
    this.#view = { cx: origin + span / 2, cz: origin + span / 2, scale: Math.min(r.width || 400, r.height || 400) / span };
    this.#fitted = r.width > 0;
  }
  #zoom(factor: number): void {
    const r = this.#canvas.getBoundingClientRect();
    this.#view = zoomAt(this.#view, factor, r.width / 2, r.height / 2, r.width, r.height, this.#minScale(), 2);
    this.#changed();
  }
  #changed(): void {
    this.#draw();
    if (this.#tab === 'area') { this.#shownRows = PAGE; this.#renderList(); }
  }

  #terrainImage(): HTMLCanvasElement | null {
    if (this.#terrain || this.#patches.length === 0) return this.#terrain;
    const cols = worldGrid().cols, image = document.createElement('canvas');
    image.width = cols; image.height = cols;
    const context = image.getContext('2d');
    if (!context) return null;
    // The viewer holds only the patches around the view: the rest of the forest is drawn as forest.
    context.fillStyle = HABITAT.terra_firme!; context.fillRect(0, 0, cols, cols);
    for (const p of this.#patches) {
      context.fillStyle = HABITAT[p.habitat] ?? '#2a3a2c';
      context.fillRect(p.id % cols, Math.floor(p.id / cols), 1, 1);
    }
    this.#terrain = image;
    return image;
  }

  #draw(): void {
    const r = this.#canvas.getBoundingClientRect(), ratio = devicePixelRatio || 1;
    if (r.width === 0) return;
    if (!this.#fitted) this.#fit();
    this.#canvas.width = Math.round(r.width * ratio); this.#canvas.height = Math.round(r.height * ratio);
    const c = this.#canvas.getContext('2d');
    if (!c) return;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.fillStyle = '#0d1512'; c.fillRect(0, 0, r.width, r.height);
    const v = this.#view, sx = (x: number) => (x - v.cx) * v.scale + r.width / 2, sz = (z: number) => (z - v.cz) * v.scale + r.height / 2;
    const terrain = this.#terrainImage(), patchM = worldGrid().patchM, origin = -patchM / 2;
    if (terrain) {
      c.imageSmoothingEnabled = v.scale * patchM < 6;
      c.drawImage(terrain, sx(origin), sz(origin), this.#span() * v.scale, this.#span() * v.scale);
    }
    c.strokeStyle = '#3d86b0'; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const river of this.#rivers) {
      c.lineWidth = Math.max(1.5, river.half * 2 * v.scale);
      c.beginPath();
      river.points.forEach((p, i) => (i === 0 ? c.moveTo(sx(p.x), sz(p.z)) : c.lineTo(sx(p.x), sz(p.z))));
      c.stroke();
    }
    // Dots grow as the map zooms in: two pixels over the whole forest, seven close up.
    const shown = this.#shown(), size = Math.min(7, Math.max(2, 2 + Math.log2(v.scale / 0.01))), half = size / 2;
    const counts = speciesCounts(this.#animals);
    // The rarest species are drawn last, over the duikers that outnumber them a hundred to one.
    const order = new Map(counts.map((s, i) => [s.speciesId, i]));
    const bySpecies = new Map<string, MapAnimal[]>();
    for (const a of this.#animals) if (shown.has(a.speciesId)) { let l = bySpecies.get(a.speciesId); if (!l) bySpecies.set(a.speciesId, l = []); l.push(a); }
    for (const [speciesId, list] of [...bySpecies].sort(([a], [b]) => order.get(a)! - order.get(b)!)) {
      c.fillStyle = speciesColour(speciesId);
      for (const a of list) {
        const x = sx(a.x), z = sz(a.z);
        if (x < -half || z < -half || x > r.width + half || z > r.height + half) continue;
        c.fillRect(x - half, z - half, size, size);
      }
    }
    const here = this.here(), followed = here.followedId === null ? undefined : this.#animals.find((a) => a.id === here.followedId);
    if (followed) { c.strokeStyle = '#ffffff'; c.lineWidth = 2; c.beginPath(); c.arc(sx(followed.x), sz(followed.z), 9, 0, Math.PI * 2); c.stroke(); }
    c.fillStyle = '#ffffff'; c.strokeStyle = '#0d1512'; c.lineWidth = 2;
    c.beginPath(); c.arc(sx(here.x), sz(here.z), 5, 0, Math.PI * 2); c.fill(); c.stroke();
    c.font = '600 11px "Manrope Variable", sans-serif'; c.fillText('You', sx(here.x) + 8, sz(here.z) + 4);
  }

  #renderLegend(): void {
    const counts = speciesCounts(this.#animals);
    this.#legend.replaceChildren(...counts.map(({ speciesId, count }) => {
      const label = document.createElement('label'); label.className = 'animal-map-key';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !this.#hidden.has(speciesId);
      box.onchange = () => { if (box.checked) this.#hidden.delete(speciesId); else this.#hidden.add(speciesId); this.#shownRows = PAGE; this.#draw(); this.#renderList(); };
      const swatch = document.createElement('span'); swatch.className = 'animal-map-swatch'; swatch.style.background = speciesColour(speciesId);
      const name = document.createElement('span'); name.textContent = `${speciesName(speciesId)} ${count.toLocaleString('en-US')}`;
      label.append(box, swatch, name);
      return label;
    }));
  }

  #renderList(): void {
    if (this.#list.contains(document.activeElement)) return;
    for (const [key, tab] of Object.entries(this.#tabs)) tab.setAttribute('aria-selected', String(key === this.#tab));
    const shown = this.#shown(), seenAll = this.#animals.length === 0;
    const rows: Array<{ id: string; speciesId: string; detail: string }> = this.#tab === 'seen'
      ? sortForList(this.seen().filter((a) => seenAll || shown.has(a.speciesId))).map((a) => ({ id: a.id, speciesId: a.speciesId, detail: a.state.replaceAll('_', ' ') }))
      : animalsInArea(this.#animals, viewArea(this.#view, this.#canvas.clientWidth, this.#canvas.clientHeight), shown).map((a) => ({ id: a.id, speciesId: a.speciesId, detail: '' }));
    this.#listTitle.textContent = this.#tab === 'seen'
      ? `${rows.length.toLocaleString('en-US')} animals on your screen now`
      : `${rows.length.toLocaleString('en-US')} animals in this part of the map`;
    this.#list.replaceChildren(...rows.slice(0, this.#shownRows).map((row) => {
      const item = document.createElement('li');
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'animal-browser-row animal-map-row';
      const swatch = document.createElement('span'); swatch.className = 'animal-map-swatch'; swatch.style.background = speciesColour(row.speciesId);
      const name = document.createElement('strong'); name.textContent = animalTitle(row.id);
      choose.append(swatch, name);
      if (row.detail) { const detail = document.createElement('span'); detail.textContent = row.detail; choose.append(detail); }
      choose.onclick = () => { this.#dialog.close(); this.watch(row.id); };
      item.append(choose);
      return item;
    }));
    this.#more.hidden = rows.length <= this.#shownRows;
    this.#more.textContent = `Show more (${(rows.length - Math.min(rows.length, this.#shownRows)).toLocaleString('en-US')} left)`;
  }
}
