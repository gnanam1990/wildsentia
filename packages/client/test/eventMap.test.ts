import { describe, expect, it } from 'vitest';
import { GRID_SIZE, PATCH_METRES } from '@vana/shared';
import { readFileSync } from 'node:fs';
import { afterEach, vi } from 'vitest';
import { EventMap, mapMarkerGlyph, mapMarkerPersonHistory, mapMarkerSubject, mapPercent, type MapMarker } from '../src/eventMap.js';
afterEach(() => vi.unstubAllGlobals());
class NodeFixture {
  children: NodeFixture[] = [];
  className = '';
  id = '';
  textContent = '';
  title = '';
  value = '';
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  open = false;
  append(...children: NodeFixture[]): void { this.children.push(...children); }
  replaceChildren(...children: NodeFixture[]): void { this.children = children; }
  setAttribute(): void {}
  contains(node: NodeFixture | null): boolean { return node !== null && (this === node || this.children.some(child => child.contains(node))); }
  add(option: { value: string }): void { if (!this.value) this.value = option.value; }
  getContext(): null { return null; }
  close(): void { this.open = false; }
  showModal(): void { this.open = true; }
}
describe('event map projection', () => {
  it('routes human birth subjects to people while animal and hunt subjects remain animal follow targets', () => {
    const marker: MapMarker = { id: 'birth_1', type: 'human_born', worldTime: 20, actorId: 'person_0005',
      actors: ['person_0005', 'person_0001', 'person_0002'], outcome: 'success', patchId: 1,
      position: { x: 0, z: 0 }, precision: 'recorded', label: 'Human birth' };
    expect(mapMarkerSubject(marker)).toEqual({ kind: 'person', id: 'person_0005' });
    expect(mapMarkerPersonHistory(marker)).toBe('person_0005');
    expect(mapMarkerGlyph(marker.type)).toBe('C');
    expect(mapMarkerSubject({ ...marker, type: 'born', actorId: 'hare_1' })).toEqual({ kind: 'animal', id: 'hare_1' });
    expect(mapMarkerGlyph('born')).toBe('B');
    expect(mapMarkerSubject({ ...marker, type: 'human_died' })).toEqual({ kind: 'person', id: 'person_0005' });
    expect(mapMarkerPersonHistory({ ...marker, type: 'human_died' })).toBe('person_0005');
    expect(mapMarkerGlyph('human_died')).toBe('X');
    expect(mapMarkerSubject({ ...marker, type: 'died', actorId: 'hare_1' })).toEqual({ kind: 'animal', id: 'hare_1' });
    expect(mapMarkerGlyph('died')).toBe('D');
    expect(mapMarkerSubject({ ...marker, type: 'immigration', actorId: 'tiger_0f00' })).toEqual({ kind: 'animal', id: 'tiger_0f00' });
    expect(mapMarkerGlyph('immigration')).toBe('A');
    expect(mapMarkerSubject({ ...marker, type: 'human_hunt', actorId: 'hare_1' })).toEqual({ kind: 'animal', id: 'hare_1' });
    expect(mapMarkerPersonHistory({ ...marker, type: 'human_hunt', actorId: 'hare_1' })).toBeNull();
    expect(mapMarkerPersonHistory({ ...marker, type: 'born', actorId: 'hare_1' })).toBeNull();
    expect(mapMarkerSubject({ ...marker, actorId: null })).toBeNull();
    expect(mapMarkerPersonHistory({ ...marker, actorId: null })).toBeNull();
  });
  it('wires human lifecycle map history to the existing selected-person dialog, distinct from Watch person', () => {
    const map = readFileSync(new URL('../src/eventMap.ts', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(map).toContain("history.textContent = 'Read person’s retained history'");
    expect(map).toContain('this.readPersonHistory(personHistoryId)');
    // Read from the map, closing the history goes back to the map (not the village list).
    expect(main).toContain('id => readPersonHistory(id, () => { void mapDialog.open(); }));');
    expect(main).toContain('id => watchSavedPerson(id)');
  });
  it('renders human birth/death history controls and invokes the selected-person callback, not Watch', async () => {
    const body = new NodeFixture(), document = { body, activeElement: null,
      createElement: () => new NodeFixture() };
    vi.stubGlobal('document', document);
    vi.stubGlobal('Option', class { constructor(readonly text: string, readonly value: string) {} });
    vi.stubGlobal('setInterval', vi.fn());
    const base: MapMarker = { id: 'birth_1', type: 'human_born', worldTime: 20, actorId: 'person_0005',
      actors: ['person_0005'], outcome: 'success', patchId: 1,
      position: { x: 0, z: 0 }, precision: 'recorded', label: 'Human birth' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ worldTime: 30, markers: [base,
      { ...base, id: 'death_1', type: 'human_died', actorId: 'person_0008', label: 'Human death' }] })));
    const watch = vi.fn(), personHistory = vi.fn();
    const map = new EventMap(vi.fn(), vi.fn(), vi.fn(), watch, personHistory);
    await map.refresh();
    const dialog = body.children[0]!, list = dialog.children.find(child => child.className === 'map-events')!;
    expect(list.children).toHaveLength(2);
    for (const [row, id] of [[list.children[0]!, 'person_0005'], [list.children[1]!, 'person_0008']] as const) {
      const buttons = row.children.filter(child => child.onclick !== null);
      expect(buttons.map(button => button.textContent)).toEqual([
        'Visit event location', 'Watch person', 'Read person’s retained history']);
      buttons[2]!.onclick!(); expect(personHistory).toHaveBeenLastCalledWith(id);
    }
    expect(personHistory).toHaveBeenCalledTimes(2);
    expect(watch).not.toHaveBeenCalled();
  });
  it('shares simulation extent and x/z orientation, including non-square-looking coast presentation', () => {
    expect(mapPercent({ x: -PATCH_METRES / 2, z: -PATCH_METRES / 2 })).toEqual({ left: 0, top: 0 });
    const centre = (GRID_SIZE - 1) * PATCH_METRES / 2;
    expect(mapPercent({ x: centre, z: centre })).toEqual({ left: 50, top: 50 });
    expect(mapPercent({ x: -100000, z: 100000 })).toEqual({ left: 0, top: 100 });
  });
});
