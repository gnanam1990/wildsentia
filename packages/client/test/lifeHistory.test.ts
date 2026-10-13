import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLifeHistory, loadSelectedClimb, loadSelectedEncounter } from '../src/lifeHistory.js';
import { treeAnchorGeometry } from '@vana/shared';
import { momentAt } from '../src/replay.js';
import { ISLAND_GRID } from '@vana/shared';
afterEach(() => vi.unstubAllGlobals());
const meta = { id: 'a', asOfWorldTime: 3600, nextEventSequence: 900, source: 'checkpoint' };
const point = { worldTime: 0, patchId: 0, state: 'resting', goal: 'rest', drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } };
const line = (n: number) => ({ eventId: `e${n}`, worldTime: n, text: `event ${n}` });
const first = () => ({ ...meta, speciesId: 'sambar', alive: true, bornAt: 0, departedAt: null, track: [point],
  moments: [line(1)], encounters: [], nextCursor: 'next' });
const last = () => ({ ...meta, moments: [line(2)], encounters: [], nextCursor: null });
const signal = () => new AbortController().signal;
const selected = () => ({ ...meta, scope: 'encounter', speciesId: 'sambar', alive: true, bornAt: 0, departedAt: null,
  encounter: { eventId: 'hunt', outcome: 'failure', predatorSpecies: 'tiger', preySpecies: 'sambar', trace: {
    version: 1, predatorId: 'tiger', preyId: 'a', patchId: 0, startWorldTime: 0, contactRadiusM: 1,
    samples: [{ seconds: 0, phase: 'escape', predator: { x: 0, z: 0, heading: 0 }, prey: { x: 10, z: 0, heading: 0 } }],
  } } });
describe('direct selected encounter loader', () => {
  it('fetches exactly one explicit recording, without an invented life track', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(selected())); vi.stubGlobal('fetch', fetcher);
    const result = await loadSelectedEncounter('a', 'hunt', signal());
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/animals/a/encounters/hunt']);
    expect(result.track).toEqual([]); expect(result.moments).toEqual([]);
    expect(result.encounters).toEqual([selected().encounter]);
  });
  it('rejects mismatched identity, scope, missing recordings and uncheckpointed trace times', async () => {
    const unrelated = selected(); unrelated.encounter.trace.preyId = 'other';
    const future = selected(); future.encounter.trace.startWorldTime = 3602;
    for (const body of [{ ...selected(), id: 'other' }, { ...selected(), scope: 'life' },
      { ...selected(), encounter: { ...selected().encounter, eventId: 'other' } }, { ...selected(), encounter: null },
      { ...selected(), bornAt: 3601 }, { ...selected(), nextEventSequence: NaN }, unrelated, future]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
      await expect(loadSelectedEncounter('a', 'hunt', signal())).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(loadSelectedEncounter('a', 'hunt', signal())).rejects.toThrow('unavailable');
  });
  it('does not publish a recording cancelled during its response', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { controller.abort(); return Response.json(selected()); }));
    await expect(loadSelectedEncounter('a', 'hunt', controller.signal)).rejects.toThrow();
  });
});
describe('direct selected tree-route loader', () => {
  const selectedClimb = () => {
    const anchor = treeAnchorGeometry(ISLAND_GRID, 210)!;
    return { ...meta, id: 'langur_1', scope: 'movement', speciesId: 'langur', alive: true, bornAt: 0, departedAt: null,
      movement: { eventId: 'tree_1', outcome: 'success', direction: 'ascend', reason: 'local_threat',
        treeAnchorId: anchor.id, verticalDistanceM: 6,
        trace: { version: 1, actorId: 'langur_1', startWorldTime: 0, destinationPatchId: 210,
          goal: 'flee', completed: true, samples: [
            { seconds: 0, position: { x: anchor.x, z: anchor.z, heading: 0 }, altitudeM: 0 },
            { seconds: 24, position: { x: anchor.x, z: anchor.z, heading: 0 }, altitudeM: 6 },
          ] } } };
  };
  it('fetches one checkpoint-pinned route without a fabricated life track', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(selectedClimb())); vi.stubGlobal('fetch', fetcher);
    const result = await loadSelectedClimb('langur_1', 'tree_1', signal());
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(['/api/animals/langur_1/movements/tree_1']);
    expect(result.track).toEqual([]); expect(result.moments).toEqual([]);
    expect(result.climbs).toEqual([selectedClimb().movement]);
  });
  it('fails closed on cross-actor, out-of-checkpoint, malformed or missing routes', async () => {
    const selected = selectedClimb();
    for (const body of [{ ...selected, id: 'other' }, { ...selected, scope: 'encounter' },
      { ...selected, movement: { ...selected.movement, trace: { ...selected.movement.trace, actorId: 'other' } } },
      { ...selected, movement: { ...selected.movement, treeAnchorId: 'wrong' } },
      { ...selected, asOfWorldTime: 10 }, { ...selected, speciesId: 'tiger' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
      await expect(loadSelectedClimb('langur_1', 'tree_1', signal())).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(loadSelectedClimb('langur_1', 'tree_1', signal())).rejects.toThrow('unavailable');
  });
});
describe('complete paged life loader', () => {
  it('publishes only a complete pinned biography and reports real page progress', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(first())).mockResolvedValueOnce(Response.json(last()));
    vi.stubGlobal('fetch', fetcher); const progress = vi.fn();
    const life = await loadLifeHistory('a', { signal: signal(), progress });
    expect(life.moments.map(m => m.eventId)).toEqual(['e1', 'e2']); expect(life.track).toEqual([point]);
    expect(progress.mock.calls).toEqual([[1, 1], [2, 2]]);
    expect(fetcher.mock.calls[1]![0]).toBe('/api/animals/a/life?cursor=next');
  });
  it('rejects partial, repeating, stale or mixed-checkpoint history instead of starting a partial replay', async () => {
    for (const second of [new Response('{}', { status: 503 }), Response.json({ ...last(), nextEventSequence: 901 }),
      Response.json({ ...last(), id: 'other' }), Response.json({ ...last(), nextCursor: 'next' }),
      Response.json({ ...last(), track: [point] }), Response.json({ ...last(), moments: [line(1)] }),
      Response.json({ ...last(), moments: [line(0)] }), Response.json({ ...last(), moments: [line(3601)] })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(first())).mockResolvedValueOnce(second));
      await expect(loadLifeHistory('a', { signal: signal() })).rejects.toThrow();
    }
  });
  it('validates biography/track metadata and explicit completion, accepting disclosed legacy positions', async () => {
    for (const change of [{ nextCursor: undefined }, { track: [{ ...point, worldTime: 3601 }] },
      { track: [point, point] }, { track: [{ ...point, position: { x: NaN, z: 0, heading: 0 } }] },
      { departedAt: 3601 }, { speciesId: '' }, { track: [{ ...point, drives: {} }] }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...first(), ...change })));
      await expect(loadLifeHistory('a', { signal: signal() })).rejects.toThrow();
    }
  });
  it('cancels in-flight work and refuses an unavailable requested encounter instead of silently playing another', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { controller.abort(); return Response.json(first()); }));
    await expect(loadLifeHistory('a', { signal: controller.signal })).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...first(), nextCursor: null })));
    await expect(loadLifeHistory('a', { signal: signal(), selectedEventId: 'missing' })).rejects.toThrow('Selected event');
  });
  it('binary-searches all moments, including equal-time ties and the last event beyond the former cap', () => {
    const moments = Array.from({ length: 5005 }, (_, i) => line(i));
    moments.push({ ...line(5004), eventId: 'tie' });
    expect(momentAt(moments, -1)).toBeUndefined(); expect(momentAt([], 100)).toBeUndefined();
    expect(momentAt(moments, 2500.5)?.eventId).toBe('e2500');
    expect(momentAt(moments, 5004)?.eventId).toBe('tie');
    expect(momentAt(moments, 9999)?.eventId).toBe('tie');
  });
});
