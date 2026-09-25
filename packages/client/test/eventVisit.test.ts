import { Scene } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventVisit, eventVisitDescription } from '../src/eventVisit.js';
import type { MapMarker } from '../src/eventMap.js';

const death: MapMarker = { id: 'died_1', type: 'died', worldTime: 90_000,
  actorId: 'chital_1', actors: ['chital_1'], outcome: 'success', patchId: 1,
  position: { x: 20, z: 30 }, precision: 'recorded', label: 'Death' };
afterEach(() => vi.unstubAllGlobals());

describe('recorded event visit', () => {
  it('distinguishes a historical death location from a present carcass', () => {
    expect(eventVisitDescription(death)).toContain('remains may already be consumed or decomposed');
    expect(eventVisitDescription({ ...death, type: 'born', precision: 'patch' })).toContain('Approximate patch area');
  });
  it('places a non-animal beacon at saved coordinates and gives keyboard-visible map/clear controls', () => {
    const elements = new Map<string, { hidden: boolean; textContent: string; onclick: (() => void) | null }>();
    for (const id of ['event-visit', 'event-visit-title', 'event-visit-detail', 'event-visit-map', 'event-visit-clear'])
      elements.set(`#${id}`, { hidden: id === 'event-visit', textContent: '', onclick: null });
    vi.stubGlobal('document', { querySelector: (selector: string) => elements.get(selector) });
    const scene = new Scene(), openMap = vi.fn(), visit = new EventVisit(scene, openMap);
    visit.show(death, () => 6);
    const beacon = scene.getObjectByName('recorded-event-beacon')!;
    expect(beacon.visible).toBe(true);
    expect(beacon.position.toArray()).toEqual([20, 6.05, 30]);
    expect(elements.get('#event-visit')!.hidden).toBe(false);
    expect(elements.get('#event-visit-title')!.textContent).toContain('chital_1');
    elements.get('#event-visit-map')!.onclick!(); expect(openMap).toHaveBeenCalledOnce();
    elements.get('#event-visit-clear')!.onclick!();
    expect(beacon.visible).toBe(false); expect(elements.get('#event-visit')!.hidden).toBe(true);
  });
});
