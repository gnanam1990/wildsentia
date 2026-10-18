/** One living animal on the map: its id, species and position (metres). */
export interface MapAnimal { id: string; speciesId: string; x: number; z: number }

/** What `/animals/map` sends: by species, ids without their species prefix and positions as one flat list. */
export interface AnimalMapPayload { worldTime: number; species: Array<{ id: string; ids: string; xz: number[] }> }

/** The animals the map draws, unpacked. */
export function unpackAnimalMap(payload: AnimalMapPayload): MapAnimal[] {
  const out: MapAnimal[] = [];
  for (const s of payload.species) {
    if (s.ids === '') continue;
    s.ids.split(',').forEach((tail, i) => {
      out.push({ id: tail.startsWith('=') ? tail.slice(1) : `${s.id}_${tail}`, speciesId: s.id, x: s.xz[i * 2]!, z: s.xz[i * 2 + 1]! });
    });
  }
  return out;
}

/** A colour for each species, told apart on the dark forest: cats warm, hoofed animals earthy, water animals cool. */
const COLOURS: Record<string, string> = {
  african_leopard: '#ff5a4f', african_golden_cat: '#ffb03b', blue_duiker: '#8fd3ff', bay_duiker: '#d99a5b',
  peters_duiker: '#f2d16b', water_chevrotain: '#4fe0c4', sitatunga: '#b48cff', forest_buffalo: '#c9c9c9',
  red_river_hog: '#ff7fb5', forest_elephant: '#ffffff', agile_mangabey: '#9be36b', crowned_eagle: '#ffef5a',
  dwarf_crocodile: '#3fa7ff',
};
const SPARE = ['#e0a3ff', '#a3ffd6', '#ffd1a3', '#a3c8ff', '#ffa3a3'];
export function speciesColour(speciesId: string): string {
  if (COLOURS[speciesId]) return COLOURS[speciesId];
  let h = 0;
  for (const c of speciesId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length]!;
}

/** The living count of each species on the map, most numerous first. */
export function speciesCounts(animals: readonly MapAnimal[]): Array<{ speciesId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const a of animals) counts.set(a.speciesId, (counts.get(a.speciesId) ?? 0) + 1);
  return [...counts].map(([speciesId, count]) => ({ speciesId, count })).sort((a, b) => b.count - a.count || (a.speciesId < b.speciesId ? -1 : 1));
}

export interface MapArea { minX: number; minZ: number; maxX: number; maxZ: number }

/** The shown animals inside an area, by species (most numerous first) and then by id. */
export function animalsInArea(animals: readonly MapAnimal[], area: MapArea, shown: ReadonlySet<string>): MapAnimal[] {
  const inside = animals.filter((a) => shown.has(a.speciesId) && a.x >= area.minX && a.x <= area.maxX && a.z >= area.minZ && a.z <= area.maxZ);
  return sortForList(inside);
}

/** Rows for a list: grouped by species, the most numerous first, each group in id order. */
export function sortForList<T extends { id: string; speciesId: string }>(rows: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.speciesId, (counts.get(r.speciesId) ?? 0) + 1);
  return [...rows].sort((a, b) => (counts.get(b.speciesId)! - counts.get(a.speciesId)!) || (a.speciesId < b.speciesId ? -1 : a.speciesId > b.speciesId ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The shown animal nearest a point, within `reachM`, or null. */
export function nearestAnimal(animals: readonly MapAnimal[], x: number, z: number, reachM: number, shown: ReadonlySet<string>): MapAnimal | null {
  let best: MapAnimal | null = null, bestD = reachM * reachM;
  for (const a of animals) {
    if (!shown.has(a.speciesId)) continue;
    const d = (a.x - x) ** 2 + (a.z - z) ** 2;
    if (d <= bestD) { best = a; bestD = d; }
  }
  return best;
}

/** A map view: the world point at its centre and its scale (pixels per metre). */
export interface MapView { cx: number; cz: number; scale: number }

/** Zoom about a pixel, keeping the world point under it fixed; the scale stays within [min, max]. */
export function zoomAt(view: MapView, factor: number, px: number, pz: number, width: number, height: number, min: number, max: number): MapView {
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const wx = view.cx + (px - width / 2) / view.scale, wz = view.cz + (pz - height / 2) / view.scale;
  return { scale, cx: wx - (px - width / 2) / scale, cz: wz - (pz - height / 2) / scale };
}

/** The world area a view shows on a canvas of this size. */
export function viewArea(view: MapView, width: number, height: number): MapArea {
  return { minX: view.cx - width / 2 / view.scale, maxX: view.cx + width / 2 / view.scale, minZ: view.cz - height / 2 / view.scale, maxZ: view.cz + height / 2 / view.scale };
}
