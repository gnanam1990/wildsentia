import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hud, type HudElements, type Passport } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';
const elements = (): HudElements => Object.fromEntries(['clock', 'season', 'population', 'passport', 'feed', 'notice']
  .map(name => [name, { innerHTML: '', textContent: '' }])) as unknown as HudElements;
const hud = () => new Hud(elements(), new WorldStore());
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => vi.unstubAllGlobals());
describe('observer history request ordering', () => {
  it('reports failed recap retrieval instead of acknowledging an unread cursor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    expect(await hud().loadRecap('deer', 0, 36000, 12)).toBe(false);
  });
  it('sends the exact sequence cursor and discards a recap cancelled by a follow change', async () => {
    const pending = deferred(), fetcher = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetcher);
    const view = hud(), load = view.loadRecap('deer', 0, 36000, 12);
    expect(fetcher).toHaveBeenCalledWith('/api/animals/deer/recap?since=0&sinceSequence=12', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    view.cancelRecap(); pending.resolve(Response.json({ lines: [{ eventId: 'birth', text: 'Newborn' }] }));
    expect(await load).toBe(false); expect(view.recap).toBeNull();
  });
  it('checks every page before acknowledging its pinned boundary, keeping a bounded explicit summary', async () => {
    const lines = (start: number) => Array.from({ length: 12 }, (_, i) => ({ eventId: `e${start + i}`, text: `line ${start + i}` }));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ until: 72000, nextEventSequence: 99,
      nextCursor: 'continuation', lines: lines(0) })).mockResolvedValueOnce(Response.json({ until: 72000,
      nextEventSequence: 99, nextCursor: null, lines: lines(12) }));
    vi.stubGlobal('fetch', fetcher);
    const view = hud();
    expect(await view.loadRecap('deer', 0, 36000, 12)).toEqual({ worldTime: 72000, nextSequence: 99 });
    expect(fetcher.mock.calls[1]![0]).toBe('/api/animals/deer/recap?cursor=continuation');
    expect(view.recap).toMatchObject({ totalLines: 24, lines: lines(12) });
    expect(view.recapStatus).toBeNull();
  });
  it('never acknowledges partial, mixed-checkpoint, looping or legacy-truncated recap responses', async () => {
    for (const second of [new Response('{}', { status: 503 }),
      Response.json({ until: 72001, nextEventSequence: 99, nextCursor: null, lines: [] }),
      Response.json({ until: 72000, nextEventSequence: 99, nextCursor: 'loop', lines: [] }),
      Response.json({ lines: [] })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ until: 72000, nextEventSequence: 99,
        nextCursor: 'loop', lines: [{ eventId: 'e1', text: 'fact' }] })).mockResolvedValueOnce(second));
      const view = hud(); expect(await view.loadRecap('deer', 0, 36000)).toBe(false);
      expect(view.recap).toBeNull(); expect(view.recapStatus!.text).toContain('previous visit');
    }
  });
  it('never lets an older passport request overwrite the newer animal selection', async () => {
    const older = deferred(); vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(Response.json({ id: 'elephant', asOfWorldTime: 3600, nextEventSequence: 50 })));
    const view = hud(), first = view.refreshPassport('deer');
    await view.refreshPassport('elephant'); older.resolve(Response.json({ id: 'deer', asOfWorldTime: 0 })); await first;
    expect(view.passport?.id).toBe('elephant');
    await view.refreshPassport(null); expect(view.passport).toBeNull();
  });
  it('exposes retained history and replay for living, dead and emigrated passports without injecting IDs', () => {
    const fields = elements();
    const store = new WorldStore(), view = new Hud(fields, store), id = 'animal<unsafe>';
    const p: Passport = { id, speciesId: 'sambar', displayName: 'Sambar', sex: 'male', ageDays: 1000, lifeStage: 'adult',
      generation: 0, alive: true, massKg: 200, thought: null, lineage: { mother: null, father: null, offspring: [] },
      skills: [], death: null, timeline: [] };
    view.passport = p;
    store.apply({ type: 'animals', animals: [{ id, speciesId: 'sambar' }] });
    view.recap = { id, days: 1, lines: [{ eventId: 'record', text: '<img onerror=alert(1)>' }], totalLines: 25 };
    for (const state of ['living', 'dead', 'emigrated']) {
      if (state !== 'living') { store.animals.clear(); p.alive = false; }
      p.death = state === 'dead' ? { cause: 'natural', worldTime: 100, eventId: 'death' } : null;
      view.render(id);
      expect(fields.passport.innerHTML).toContain('Browse retained history');
      expect(fields.passport.innerHTML).toContain('data-replay=');
      expect(fields.passport.innerHTML).toContain('Latest 12 of 25 summary lines');
      expect(fields.passport.innerHTML).not.toContain('<unsafe>');
      expect(fields.passport.innerHTML).not.toContain('<img');
    }
  });
});
