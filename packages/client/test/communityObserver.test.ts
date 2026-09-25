import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@vana/sim';
import { CommunityObserver, communityEventText, communityFamilyText, communityHomeText, communityJourneyText, communityRelationshipText, isCommunityPage, type CommunityPage } from '../src/communityObserver.js';

const page = (): CommunityPage => ({ source: 'checkpoint', asOfWorldTime: 0, nextEventSequence: 1, events: [], notice: 'Recorded household.',
  community: createWorld({ seed: 1, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
    initialAgents: {}, minPopulation: {}, communityProfile: 'household_v1' }).community });
afterEach(() => vi.unstubAllGlobals());
describe('public no-login community observation', () => {
  it('shows recorded family lineage, dependent child needs and care outcomes without inventing a successful birth', () => {
    const c = page().community!, mother = c.people[0]!, father = c.people[1]!;
    c.version = 7;
    mother.bornAt = 0; mother.generation = 0; mother.motherId = null; mother.fatherId = null;
    mother.pregnancy = { fatherId: father.id, conceivedAt: 10, dueAt: 20, fetusKg: 1.2, conceivedEventId: 'conception_1' };
    expect(communityFamilyText(mother, c)).toContain('Birth is not guaranteed');
    const child = { ...mother, id: 'person_0005', name: 'Child', ageDays: 0, bornAt: 30, generation: 1,
      motherId: mother.id, fatherId: father.id, pregnancy: null };
    c.people.push(child);
    expect(communityFamilyText(child, c)).toContain(`Mother: ${mother.name} (${mother.id})`);
    expect(communityFamilyText(child, c)).toContain(`Father: ${father.name} (${father.id})`);
    const birth = { id: 'birth_1', type: 'human_born', worldTime: 30, outcome: 'success',
      actors: [child.id, mother.id, father.id, c.id], conditions: { generation: 1 }, effects: { massKg: 2.2 } };
    expect(communityEventText(birth)).toContain(`${child.id} born to ${mother.id} and ${father.id}`);
    const care = { ...birth, id: 'care_1', type: 'human_cared', worldTime: 40,
      actors: [child.id, father.id, c.id], conditions: { relationship: 'parent' }, effects: { foodKg: -.2, waterL: -.3 } };
    expect(communityEventText(care)).toContain('food 0.200 kg, water 0.300 L delivered');
    expect(communityEventText({ ...birth, type: 'human_conceived', actors: [mother.id, father.id, c.id] })).toContain('birth is not guaranteed');
    expect(communityEventText({ ...birth, type: 'human_pregnancy_lost', actors: [mother.id, father.id, c.id],
      conditions: { reason: 'insufficient_growth' }, effects: { returnedKg: 1.2 } })).toContain('1.200 kg returned to soil');
    c.version = 6; expect(communityFamilyText(child, c)).toBe('');
  });
  it('distinguishes saved travel, destination work and source facts without claiming a successful trip or ETA', () => {
    const person = page().community!.people[0]!;
    expect(communityJourneyText(person)).toBe('No active task.');
    person.task = { kind: 'gather_food', phase: 'travel', destination: { ...person.position },
      startedAt: 0, remainingSeconds: 900, eventId: 'task_1', journey: { destinationPatchId: person.patchId, waypoints: [{ ...person.position }] } };
    const text = communityJourneyText(person);
    expect(text).toContain(`Saved location: patch ${person.patchId}`);
    expect(text).toContain('1 route waypoints remaining'); expect(text).toContain('Outcome is not guaranteed');
    expect(text).not.toContain('ETA');
    person.task.phase = 'work'; person.task.journey!.waypoints = [];
    expect(communityJourneyText(person)).toContain('900 world seconds of task work remaining');
    const event = { id: 'collected_1', type: 'human_resource_collected', worldTime: 0, outcome: 'success',
      actors: [person.id, 'village_0001'], conditions: { action: 'collect_water', sourcePatchId: 183 }, effects: { waterL: 4 } };
    expect(communityEventText(event)).toContain('recorded site: patch 183');
    expect(communityEventText(event)).toContain('waterL: 4.000');
    expect(isCommunityPage({ ...page(), events: [event] })).toBe(true);
    const invalid = page(); invalid.community!.people[0]!.task = structuredClone(person.task);
    invalid.community!.people[0]!.task!.journey!.destinationPatchId = 399;
    expect(isCommunityPage(invalid)).toBe(false);
  });
  it('shows construction, recorded material condition and paid repairs with units, not implied finished shelter', () => {
    const c = page().community!;
    expect(communityHomeText(c)).toContain('No completed shelter yet');
    c.building.stage = 'occupied'; c.building.completedAt = 10;
    c.building.materials = { timberKg: 48, fibreKg: 36 };
    expect(communityHomeText(c)).toContain('Home condition 50.0% · habitable shelter');
    expect(communityHomeText(c)).toContain('48.00 / 96 kg');
    c.building.materials.fibreKg = 10;
    expect(communityHomeText(c)).toContain('uninhabitable; residents have no shelter benefit');
    const event = { id: 'repair_1', type: 'building_repaired', worldTime: 100, outcome: 'success',
      actors: ['person_0001', c.id], effects: { timberKg: 4, fibreKg: 6, conditionBefore: .85, conditionAfter: .93 } };
    expect(communityEventText(event)).toContain('timber 4.000 kg; fibre 6.000 kg');
    expect(communityEventText(event)).toContain('85.0% → 93.0%');
    expect(communityEventText({ ...event, type: 'building_shelter_changed', conditions: { availability: 'uninhabitable', reason: 'weathered' } })).toContain('home uninhabitable · weathered');
    c.version = 8; c.building.stage = 'site'; c.building.completedAt = null;
    c.building.maintenance = { repairsCompleted: 0, lastRepairAt: null, collapses: 1,
      lastCollapseAt: 100, lastCollapseEventId: 'collapse_1', rebuildsCompleted: 0 };
    expect(communityHomeText(c)).toContain('Home collapsed 1 time');
    expect(communityHomeText(c)).toContain('No completed shelter is available');
    expect(communityEventText({ ...event, type: 'building_storm', conditions: { rainfallL: 4200 },
      effects: { timberLostKg: 1.2, fibreLostKg: 2.3 } })).toContain('rain 4200 L added to water budget');
    expect(communityEventText({ ...event, type: 'building_collapsed', conditions: { cause: 'flood' },
      effects: { salvagedTimberKg: 1, salvagedFibreKg: .5 } })).toContain('home collapsed after flood');
    expect(communityEventText({ ...event, type: 'building_rebuilt', effects: { rebuildsCompleted: 1 } })).toContain('completed recorded home reconstruction');
    c.version = 3; delete c.building.maintenance;
    expect(communityHomeText(c)).toContain('older household');
  });
  it('labels recorded co-work and skill gains without claiming emotions or guaranteed task success', () => {
    const c = page().community!;
    expect(communityRelationshipText(c)[0]).toContain('No shared work recorded');
    c.relationships = [{ members: [c.people[0]!.id, c.people[1]!.id], sharedWorkSeconds: 3600,
      lastInteractionAt: 4000, reportedHours: 1, trust: .025,
      lessons: [{ learnerId: c.people[0]!.id, teacherId: c.people[1]!.id, skill: 'building', observedSeconds: 3600, gain: .009, reportedGain: .009 }] }];
    expect(communityRelationshipText(c)[0]).toContain('1.00 shared work hours · cooperation score 2.5%');
    expect(communityRelationshipText(c)[0]).toContain('building +0.90 percentage points');
    const learned = { id: 'learn_1', type: 'human_skill_learned', worldTime: 3600, outcome: 'success',
      actors: [c.people[0]!.id, c.people[1]!.id, c.id], conditions: { skill: 'building' }, effects: { skillGain: .009 } };
    expect(communityEventText(learned)).toContain('learned building by working alongside');
    expect(communityEventText(learned)).toContain('0.90 percentage points');
    expect(communityEventText({ ...learned, type: 'human_cooperated', effects: { sharedWorkSeconds: 3600 } })).toContain('1.00 shared work hours recorded');
    c.version = 2; delete c.relationships;
    expect(communityRelationshipText(c)[0]).toContain('older household');
  });
  it('distinguishes fishing intentions from outcomes and renders recorded catch/fuel amounts without inventing success', () => {
    const started = { id: 'start_1', type: 'human_task_started', worldTime: 0, outcome: 'success', actors: ['village_0001'], conditions: { action: 'fish' } };
    expect(communityEventText(started)).toContain('outcome not yet known'); expect(communityEventText(started)).not.toContain('success');
    const failed = { ...started, type: 'human_task_finished', outcome: 'failure', conditions: { action: 'fish', reason: 'no_catch' }, effects: {} };
    expect(communityEventText(failed)).toContain('failure · no catch'); expect(communityEventText(failed)).not.toContain('rawFishKg');
    const cooked = { ...failed, outcome: 'success', conditions: { action: 'cook', reason: 'cooked' }, effects: { rawFishKg: -.2, foodKg: .2, fuelKg: .02 } };
    expect(communityEventText(cooked)).toContain('fuelKg: 0.020');
    expect(isCommunityPage({ ...page(), events: [cooked] })).toBe(true);
    expect(isCommunityPage({ ...page(), events: [{ ...cooked, effects: { fuelKg: 'fake' } }] })).toBe(false);
    expect(isCommunityPage({ ...page(), events: [{ ...cooked, conditions: { action: {} } }] })).toBe(false);
  });
  it('validates checkpoint identity, bounded events, timestamps and state without trusting response types', () => {
    const p = page(); expect(isCommunityPage(p)).toBe(true);
    expect(isCommunityPage({ ...p, community: null })).toBe(true);
    expect(isCommunityPage({ ...p, asOfWorldTime: 10 })).toBe(false);
    expect(isCommunityPage({ ...p, source: 'live' })).toBe(false);
    expect(isCommunityPage({ ...p, community: { ...p.community, version: 99 } })).toBe(false);
    expect(isCommunityPage({ ...p, events: [{ id: 'x', type: 'human_died', outcome: 'success', worldTime: 1, actors: [p.community!.id] }] })).toBe(false);
    expect(isCommunityPage({ ...p, events: [{ id: 'x', type: 'human_died', outcome: 'success', worldTime: 0, actors: ['another-community'] }] })).toBe(false);
  });
  it('fetches only on demand, surfaces error/retry and never keeps stale data labelled current', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page())))
      .mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(page())));
    vi.stubGlobal('fetch', fetcher); const observer = new CommunityObserver();
    expect(fetcher).not.toHaveBeenCalled(); await observer.refresh(); expect(observer.page?.community?.people).toHaveLength(4);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/community');
    expect(fetcher.mock.calls[0]![1].method).toBeUndefined();
    await observer.refresh(); expect(observer.page).toBeNull(); expect(observer.error).toMatch(/unavailable/);
    await observer.refresh(); expect(observer.error).toBe(''); expect(observer.page).not.toBeNull();
  });
  it('cancels stale open/close responses and rejects malformed successful responses', async () => {
    let resolve!: (v: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...page(), community: null })))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetcher); const observer = new CommunityObserver();
    const first = observer.refresh(); const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    observer.close(); expect(signal.aborted).toBe(true);
    await observer.refresh(); resolve(new Response(JSON.stringify(page()))); await first;
    expect(observer.page?.community).toBeNull();
    await observer.refresh(); expect(observer.page).toBeNull(); expect(observer.error).toMatch(/Invalid/);
  });
});
