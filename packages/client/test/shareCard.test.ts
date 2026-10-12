import { afterEach, describe, expect, it, vi } from 'vitest';
import { animalFromHash, animalLink, initialFollowId } from '../src/animalLink.js';
import { buildShareCard, type SharePassport } from '../src/shareCard.js';
import { isSharePassport, ShareStory } from '../src/shareStory.js';

const passport = (overrides: Partial<SharePassport> = {}): SharePassport => ({
  id: 'tiger_01', speciesId: 'tiger', displayName: 'Tiger', ageDays: 400, lifeStage: 'adult', alive: true,
  death: null, state: 'resting', currentGoal: 'rest', source: 'checkpoint', asOfWorldTime: 20, nextEventSequence: 3,
  timeline: [{ id: 'evt-1', type: 'hunt', worldTime: 12, outcome: 'failure' }], ...overrides,
});
const card = (p: SharePassport) => buildShareCard({ passport: p, animal: null, currentUrl: 'https://vana.example/?stats&token=secret#old' });
afterEach(() => vi.unstubAllGlobals());

describe('checkpoint story and observation links', () => {
  it('exports an excerpt with identity, source time, intact event IDs and a usable link', () => {
    const text = card(passport());
    expect(text).toContain('WILDSENTIA · Tiger (tiger)'); expect(text).toContain('Animal: tiger_01');
    expect(text).toContain('hunt (failure) · evt-1 · world second 12');
    expect(text).toContain('Checkpoint world time: 20 · next event 3');
    expect(text).toContain('Simulation outcomes are authoritative');
    expect(text).toContain('Observe: https://vana.example/#animal=tiger_01');
    expect(text).not.toMatch(/secret|#old|stats/); expect(card(passport())).toBe(text);
  });
  it('does not infer death from an absent passport or an emigrant’s alive=false field', () => {
    const text = buildShareCard({ passport: null, animal: { id: 'elephant_01', speciesId: 'elephant', patchId: 1,
      state: 'resting', currentGoal: 'drink', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 } } });
    expect(text).toContain('passport unavailable'); expect(text).not.toMatch(/deceased|Recorded death/);
    expect(text).toContain('Observed state: resting · goal drink');
    expect(card(passport({ alive: false, state: 'emigrated' }))).toContain('Departed from the forest');
    expect(card(passport({ alive: false, state: 'unknown' }))).toContain('no death record available');
    const dead = card(passport({ alive: false, state: 'dead', death: { eventId: 'evt-2', cause: 'natural', worldTime: 18 } }));
    expect(dead).toContain('Recorded death'); expect(dead).toContain('Cause: natural · event evt-2');
  });
  it('never mixes an older checkpoint story with another or newer live actor', () => {
    const text = buildShareCard({ passport: passport(), animal: { id: 'tiger_other', speciesId: 'tiger', patchId: 0,
      state: 'dead', currentGoal: 'hunt', drives: { hunger: 0, thirst: 0, fear: 0, fatigue: 0 } } });
    expect(text).toContain('Alive at this checkpoint'); expect(text).toContain('Observed state: resting · goal rest');
    expect(text).not.toContain('tiger_other');
  });
  it('fits long records by removing whole event lines, retaining provenance and complete URLs', () => {
    const long = passport({ id: 'a'.repeat(128), displayName: '🐘'.repeat(250), speciesId: 's'.repeat(128),
      lifeStage: 'l'.repeat(32), alive: false, state: 'dead', death: { cause: 'c'.repeat(256), eventId: 'd'.repeat(128), worldTime: 18 },
      timeline: Array.from({ length: 50 }, (_, i) => ({ id: `evt_${i}_${'e'.repeat(100)}`, type: 'hunt', outcome: 'failure', worldTime: 12 })) });
    const text = buildShareCard({ passport: long, animal: null, currentUrl: `https://vana.example/${'p'.repeat(200)}` });
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain('Checkpoint world time: 20 · next event 3');
    expect(text).toContain('Simulation outcomes are authoritative');
    expect(text.endsWith(`#animal=${long.id}`)).toBe(true);
  });
  it('supports living and archived deep links, and rejects ambiguous/invalid links', () => {
    const living = new Map([['deer_1', {}]]);
    const link = animalLink('http://localhost:5175/?stats#old', 'tiger_01')!;
    expect(animalFromHash(new URL(link).hash)).toBe('tiger_01');
    expect(initialFollowId('#animal=tiger_01', 'deer_1', living)).toBe('tiger_01');
    expect(initialFollowId('#animal=tiger_01', null, new Map())).toBe('tiger_01');
    expect(initialFollowId('', 'deer_1', living)).toBe('deer_1');
    expect(initialFollowId('', 'missing', living)).toBe('deer_1');
    expect(initialFollowId('', null, new Map())).toBeNull();
    for (const hash of ['#animal=', '#animal=../../admin', '#animal=%00', '#animal=a&animal=b', '#animal=' + 'x'.repeat(200)])
      expect(animalFromHash(hash)).toBeNull();
    for (const url of ['javascript:alert(1)', 'file:///tmp/forest', 'https://user:password@example.com', 'not a URL'])
      expect(animalLink(url, 'tiger_01')).toBeNull();
  });
});

describe('public story retrieval and copying', () => {
  it('requires a matching committed passport and rejects future/malformed records', () => {
    expect(isSharePassport(passport(), 'tiger_01')).toBe(true);
    for (const p of [passport({ id: 'other' }), passport({ source: 'live' }), passport({ asOfWorldTime: -1 }),
      passport({ ageDays: NaN }), passport({ state: 'dead' }), passport({ alive: false, death: { cause: 'natural', eventId: 'e', worldTime: 21 } }),
      passport({ timeline: [{ id: 'e', type: 'born', worldTime: 21, outcome: 'success' }] }), { ...passport(), death: undefined }])
      expect(isSharePassport(p, 'tiger_01')).toBe(false);
  });
  it('fetches one saved story and preserves it through successful or denied clipboard attempts', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(passport())); vi.stubGlobal('fetch', fetcher);
    const story = new ShareStory(); await story.open('tiger_01', 'https://vana.example/');
    expect(fetcher.mock.calls[0]![0]).toBe('/api/animals/tiger_01/passport'); const snapshot = story.text;
    expect(await story.copy(undefined)).toBe(false);
    expect(story.status).toContain('Select text'); expect(story.text).toBe(snapshot);
    expect(await story.copy(async () => { throw new Error('denied'); })).toBe(false);
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await story.copy(write)).toBe(true); expect(write).toHaveBeenCalledWith(snapshot);
    expect(story.status).toBe('Story copied.'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('discards late requests when replaced or closed, including late clipboard completions', async () => {
    let resolve!: (r: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValueOnce(Response.json(passport({ id: 'deer_1' })));
    vi.stubGlobal('fetch', fetcher);
    const story = new ShareStory(), old = story.open('tiger_01', 'https://vana.example/');
    await story.open('deer_1', 'https://vana.example/');
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    resolve(Response.json(passport())); await old; expect(story.text).toContain('Animal: deer_1');
    let finish!: () => void;
    const copying = story.copy(() => new Promise<void>(r => { finish = r; }));
    story.close(); const status = story.status; finish(); await copying; expect(story.status).toBe(status);
    fetcher.mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }));
    const closed = story.open('tiger_01', 'https://vana.example/'); story.close();
    resolve(Response.json(passport())); await closed; expect(story.text).toBe('');
  });
  it('clears old content on failure and allows retry without exporting a guessed story', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(Response.json(passport())).mockResolvedValueOnce(Response.json({ id: 'tiger_01' }));
    vi.stubGlobal('fetch', fetcher);
    const story = new ShareStory(); await story.open('tiger_01', 'https://vana.example/');
    expect(story.text).toBe(''); expect(story.status).toContain('record is unavailable');
    await story.open('tiger_01', 'https://vana.example/'); expect(story.text).toContain('Animal: tiger_01');
    await story.open('tiger_01', 'https://vana.example/'); expect(story.text).toBe('');
    expect(story.status).toContain('Could not verify'); expect(await story.copy(vi.fn())).toBe(false);
  });
});
