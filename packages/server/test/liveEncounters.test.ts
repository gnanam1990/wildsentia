import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { treeAnchorForPatch, treeAnchorGeometry, waterAccessPosition, type EncounterAppearance, type WorldEvent } from '@vana/shared';
import { collectLiveEncounters, collectLiveMovements, encounterAppearance, indexLiveMovements, isRecordedTreeClimb, selectLiveMovements } from '../src/liveEncounters.js';
import { createWorld } from '../../sim/src/world.js';
import { makeAgent } from '../../sim/test/helpers.js';
import { isLiveEncounterFrame, LiveEncounterPlayer } from '../../client/src/liveEncounters.js';
import { displaySecondAt, paceMovement } from '@vana/shared';
import { CONGO_GRID, ISLAND_GRID } from '@vana/shared';

const p = (x: number) => ({ x, z: 0, heading: 0 });
const actors = new Map<string, EncounterAppearance>([
  ['t', { id: 't', speciesId: 'tiger', sizeRatio: 1, coatVariant: 0 }],
  ['s', { id: 's', speciesId: 'sambar', sizeRatio: 0.2, coatVariant: 1 }],
]);
const event: WorldEvent = { id: 'hunt_1', type: 'hunt', worldTime: 30, simVersion: 'sim_0.7.0',
  patchId: 0, actors: ['t', 's'], conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative',
  encounter: { version: 1, predatorId: 't', preyId: 's', patchId: 0, startWorldTime: 0, contactRadiusM: 1,
    samples: [{ seconds: 0, phase: 'chase', predator: p(0), prey: p(5) },
      { seconds: 30, phase: 'contact', predator: p(9), prey: p(10) }] } };

describe('bounded live encounter collection', () => {
  it('records sex and life stage for delayed character art without changing simulation', () => {
    const animal = makeAgent('elephant', { sex: 'female', lifeStage: 'adult', massKg: 2000 });
    expect(encounterAppearance(animal, 2500)).toMatchObject({ speciesId: 'elephant',
      sex: 'female', lifeStage: 'adult', sizeRatio: .8 });
  });
  it('admits an actual v0.25 simulated tree decision with one composite trace', () => {
    const world = createWorld({ seed: 17, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { langur: 1, tiger: 1 }, minPopulation: {}, retainEvents: 'all' });
    const patch = world.patches.find(p => treeAnchorForPatch(ISLAND_GRID, p))!, anchor = treeAnchorForPatch(ISLAND_GRID, patch)!;
    const langur = world.agents.find(a => a.speciesId === 'langur')!, tiger = world.agents.find(a => a.speciesId === 'tiger')!;
    Object.assign(langur, { patchId: patch.id, position: { x: anchor.x + 12, z: anchor.z + 5, heading: 0 },
      sex: 'male', dependentOn: null, pregnantSince: null, offspringIds: [],
      drives: { hunger: .05, thirst: .05, fatigue: 0, fear: 1 } });
    Object.assign(tiger, { patchId: patch.id, position: { x: anchor.x + 25, z: anchor.z + 15, heading: 0 },
      drives: { hunger: .2, thirst: .2, fatigue: 0, fear: 0 } });
    const appearances = new Map([[langur.id, { id: langur.id, speciesId: 'langur', sizeRatio: 1, coatVariant: 0 }]]);
    world.log.take(); world.step(1);
    const events = world.log.byActor(langur.id), climb = events.find(e => e.type === 'tree_climbed')!;
    expect(climb).toBeDefined(); expect(isRecordedTreeClimb(ISLAND_GRID, climb)).toBe(true);
    const movements = collectLiveMovements(ISLAND_GRID, events, appearances, 0, world.agents);
    expect(movements).toHaveLength(1);
    expect(movements[0]!.eventId).toBe(climb.id);
    expect(movements[0]!.trace.samples.at(-1)!.altitudeM).toBe(6);
  });
  const climb = (direction: 'ascend' | 'descend' = 'ascend'): WorldEvent => {
    const anchor = treeAnchorGeometry(ISLAND_GRID, 210)!;
    const from = { x: anchor.x - 2, z: anchor.z, heading: 0 }, trunk = { x: anchor.x, z: anchor.z, heading: 0 };
    return { id: 'tree_1', type: 'tree_climbed', worldTime: 34, simVersion: 'sim_0.25.0', patchId: 210,
      actors: ['langur_1'], goal: direction === 'ascend' ? 'flee' : 'rest',
      conditions: { direction, treeAnchorId: anchor.id, reason: direction === 'ascend' ? 'local_threat' : 'threat_gone' },
      outcome: 'success', effects: { verticalDistanceM: 6 }, causalParents: [], confidence: 'authoritative',
      movement: { version: 1, actorId: 'langur_1', startWorldTime: 0, destinationPatchId: 210,
        goal: direction === 'ascend' ? 'flee' : 'rest', completed: true,
        samples: direction === 'ascend'
          ? [{ seconds: 0, position: from }, { seconds: 10, position: trunk, altitudeM: 0 },
            { seconds: 34, position: trunk, altitudeM: 6 }]
          : [{ seconds: 0, position: trunk, altitudeM: 6 }, { seconds: 24, position: trunk, altitudeM: 0 }] } };
  };
  it('admits one saved ground-to-trunk-to-height route and follows its recorded altitude', () => {
    const e = climb(), anchor = treeAnchorGeometry(ISLAND_GRID, 210)!;
    expect(isRecordedTreeClimb(ISLAND_GRID, e)).toBe(true);
    const appearance = new Map([['langur_1', { id: 'langur_1', speciesId: 'langur', sizeRatio: 1, coatVariant: 0 }]]);
    const end = makeAgent('langur', { id: 'langur_1', patchId: 210,
      position: { x: anchor.x, z: anchor.z, heading: 0 }, altitudeM: 6 });
    const routes = collectLiveMovements(ISLAND_GRID, [e], appearance, 0, [end]);
    expect(routes).toHaveLength(1);
    const frame = { id: 'tree-hour', startWorldTime: 0, endWorldTime: 3600, rate: 1,
      elapsedWorldSeconds: 22, encounters: [], movements: routes };
    expect(isLiveEncounterFrame(frame)).toBe(true);
    const player = new LiveEncounterPlayer(); expect(player.apply(frame, 100)).toBe(true);
    expect(player.poses(100).get('langur_1')).toMatchObject({ position: { x: anchor.x, z: anchor.z, altitudeM: 3 },
      climbVisualPhase: 'ascending', phase: 'recorded tree ascent' });
    expect(collectLiveMovements(ISLAND_GRID, [e, { ...e, id: 'tree_2' }], appearance, 0, [end])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [e], appearance, 0, [{ ...end, altitudeM: 0 }])).toEqual([]);
  });
  it('preserves a descent and an interrupted ground-only approach without claiming ascent', () => {
    const descent = climb('descend'), anchor = treeAnchorGeometry(ISLAND_GRID, 210)!;
    expect(isRecordedTreeClimb(ISLAND_GRID, descent)).toBe(true);
    const approach = climb(); approach.outcome = 'interrupted'; approach.effects.verticalDistanceM = 0;
    approach.movement!.completed = false; approach.movement!.samples = approach.movement!.samples.slice(0, 2).map(s => ({ seconds: s.seconds, position: s.position }));
    expect(isRecordedTreeClimb(ISLAND_GRID, approach)).toBe(true);
    const appearance = new Map([['langur_1', { id: 'langur_1', speciesId: 'langur', sizeRatio: 1, coatVariant: 0 }]]);
    const end = makeAgent('langur', { id: 'langur_1', patchId: 210,
      position: { x: anchor.x, z: anchor.z, heading: 0 } });
    expect(collectLiveMovements(ISLAND_GRID, [descent], appearance, 0, [end])).toHaveLength(1);
    expect(collectLiveMovements(ISLAND_GRID, [approach], appearance, 0, [end])).toHaveLength(1);
    for (const edit of [(e: WorldEvent) => { e.effects.verticalDistanceM = 0; },
      (e: WorldEvent) => { e.conditions.treeAnchorId = 'wrong'; },
      (e: WorldEvent) => { e.movement!.samples[2]!.position.x++; },
      (e: WorldEvent) => { e.conditions.direction = 'descend'; }]) {
      const invalid = climb(); edit(invalid); expect(isRecordedTreeClimb(ISLAND_GRID, invalid)).toBe(false);
      expect(collectLiveMovements(ISLAND_GRID, [invalid], appearance, 0, [end])).toEqual([]);
    }
  });
  it('admits a canopy dweller going up to rest and down to forage, and no other pairing', () => {
    const roost = climb(); roost.goal = 'rest'; roost.movement!.goal = 'rest'; roost.conditions.reason = 'roost';
    expect(isRecordedTreeClimb(ISLAND_GRID, roost)).toBe(true);
    const foray = climb('descend'); foray.conditions.reason = 'forage';
    expect(isRecordedTreeClimb(ISLAND_GRID, foray)).toBe(true);
    // Up to rest is a roost, never a flight; down is never to roost.
    const fled = climb(); fled.conditions.reason = 'roost';
    expect(isRecordedTreeClimb(ISLAND_GRID, fled)).toBe(false);
    const down = climb('descend'); down.conditions.reason = 'roost';
    expect(isRecordedTreeClimb(ISLAND_GRID, down)).toBe(false);
  });
  it('admits a canopy dweller crossing aloft from its tree to a neighbouring tree, and nothing that leaves the canopy', () => {
    const world = createWorld({ seed: 7, speciesDir: fileURLToPath(new URL('../../../config/species-congo', import.meta.url)),
      terrainProfile: 'congo_v1', initialAgents: { agile_mangabey: 40 }, minPopulation: {}, retainEvents: 'all' });
    let hop: WorldEvent | undefined;
    for (let h = 0; h < 48 && !hop; h++) {
      world.step(1);
      hop = world.log.all().find((e) => e.type === 'tree_climbed' && e.conditions.direction === 'traverse');
    }
    expect(hop).toBeDefined();
    expect(isRecordedTreeClimb(CONGO_GRID, hop!)).toBe(true);
    const copy = () => structuredClone(hop!);
    const middle = Math.floor(hop!.movement!.samples.length / 2);
    for (const edit of [(e: WorldEvent) => { e.movement!.samples[middle]!.altitudeM = 0; },
      (e: WorldEvent) => { e.movement!.samples[middle]!.position.x += 20; },
      (e: WorldEvent) => { e.conditions.treeAnchorId = 'wrong'; },
      (e: WorldEvent) => { e.conditions.from = (e.conditions.from as number) + 5; },
      (e: WorldEvent) => { e.conditions.reason = 'roost'; },
      (e: WorldEvent) => { e.goal = 'rest'; },
      (e: WorldEvent) => { e.effects.verticalDistanceM = 7; }]) {
      const invalid = copy(); edit(invalid); expect(isRecordedTreeClimb(CONGO_GRID, invalid)).toBe(false);
    }
  }, 120_000);
  // Water contact is recorded around the patch's access point, which sim_0.30.0 moved off the centre.
  const source = waterAccessPosition(ISLAND_GRID, 0);
  const w = (dx: number) => ({ x: source.x + dx, z: source.z, heading: Math.PI / 2 });
  const drinking = () => {
    const { encounter: _encounter, ...base } = event;
    const moved: WorldEvent = { ...base, id: 'approach', type: 'moved', actors: ['s'],
      movement: { version: 1, actorId: 's', startWorldTime: 0, destinationPatchId: 0, goal: 'find_water', completed: true,
        samples: [{ seconds: 0, position: w(10) }, { seconds: 30, position: w(1.5) }] } };
    const drank: WorldEvent = { ...base, id: 'drink', type: 'drank', actors: ['s'], worldTime: 3600, goal: 'find_water',
      position: { ...w(1.5), heading: -Math.PI / 2 }, causalParents: ['approach'], effects: { litres: 2 },
      conditions: { arrivalWorldTime: 30, drinkingSeconds: 3570, sourceX: source.x, sourceZ: source.z, contactRadiusM: 2 } };
    const end = makeAgent('sambar', { id: 's', position: { ...drank.position! } });
    return { moved, drank, end };
  };
  it('links only recorded water contact to its approach and detaches the activity', () => {
    const { moved, drank, end } = drinking();
    const routes = collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end]);
    expect(routes[0]!.activity).toMatchObject({ eventId: 'drink', startSeconds: 30, endSeconds: 3600, litres: 2 });
    expect(isLiveEncounterFrame({ id: 'water', startWorldTime: 0, endWorldTime: 3600, rate: 12,
      elapsedWorldSeconds: 0, encounters: [], movements: routes })).toBe(true);
    drank.position!.x = 99;
    expect(routes[0]!.activity!.position.x).toBe(source.x + 1.5);
  });
  it('holds a stationary drinker only with matching pre-tick evidence and no movement', () => {
    const { moved, drank, end } = drinking();
    drank.conditions.arrivalWorldTime = 0; drank.conditions.drinkingSeconds = 3600; drank.causalParents = [];
    const initial = w(1.5), starts = new Map([['s', initial]]);
    const index = indexLiveMovements(ISLAND_GRID, [drank], actors, 0, [end], starts);
    expect(index.get('s')).toMatchObject({ eventId: 'drink', stationary: true,
      trace: { samples: [{ seconds: 0, position: initial }] }, activity: { startSeconds: 0 } });
    initial.x = 20;
    expect(index.get('s')!.trace.samples[0]!.position.x).toBe(source.x + 1.5);
    expect(indexLiveMovements(ISLAND_GRID, [drank], actors, 0, [end]).size).toBe(0);
    expect(indexLiveMovements(ISLAND_GRID, [drank], actors, 0, [end], starts).size).toBe(0);
    expect(indexLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end], new Map([['s', w(1.5)]]))
      .get('s')!.activity).toBeUndefined();
    expect(indexLiveMovements(ISLAND_GRID, [drank], actors, 3600, [end], new Map([['s', w(1.5)]])).size).toBe(0);
  });
  it('omits ambiguous, unlinked, malformed or displaced drinking without inventing an action', () => {
    const edits: Array<(e: WorldEvent) => void> = [
      e => { e.causalParents = []; }, e => { e.conditions.arrivalWorldTime = 31; },
      e => { e.conditions.drinkingSeconds = -1; }, e => { e.conditions.drinkingSeconds = 3571; },
      e => { e.conditions.drinkingSeconds = NaN; }, e => { e.effects.litres = 0; },
      e => { e.conditions.sourceX = source.x + 1; }, e => { e.conditions.contactRadiusM = 10; },
      e => { e.position!.x = source.x + 2.1; }, e => { e.worldTime = 3500; },
      e => { e.actors.push('t'); }, e => { delete e.conditions.arrivalWorldTime; },
    ];
    for (const edit of edits) {
      const { moved, drank, end } = drinking(); edit(drank);
      expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end])[0]!.activity).toBeUndefined();
    }
    const { moved, drank, end } = drinking();
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank, { ...drank, id: 'drink2' }], actors, 0, [end])[0]!.activity).toBeUndefined();
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank, event], actors, 0, [end])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [{ ...end, alive: false }])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [{ ...end, position: w(30) }])).toEqual([]);
  });
  it('tolerates sub-microsecond hour-boundary rounding, not out-of-hour drinking', () => {
    const { moved, drank, end } = drinking();
    drank.conditions.drinkingSeconds = 3570 + 1e-9;
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end])[0]!.activity!.endSeconds).toBe(3600);
    drank.conditions.drinkingSeconds = 3570 - 1e-9;
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end])[0]!.activity).toBeDefined();
    drank.conditions.drinkingSeconds = 3570.01;
    expect(collectLiveMovements(ISLAND_GRID, [moved, drank], actors, 0, [end])[0]!.activity).toBeUndefined();
  });
  it('publishes one owned route through the wire/player without fabricating a straight shortcut', () => {
    const { encounter: _encounter, ...base } = event;
    const moved: WorldEvent = { ...base, id: 'move_1', type: 'moved', actors: ['s'],
      movement: { version: 1, actorId: 's', startWorldTime: 0, destinationPatchId: 0, goal: 'find_water', completed: true,
        samples: [{ seconds: 0, position: p(0) }, { seconds: 10, position: p(100) },
          { seconds: 30, position: { x: 100, z: 100, heading: 0 } }] } };
    const end = makeAgent('sambar', { id: 's', position: { x: 100, z: 100, heading: 0 } });
    const movements = collectLiveMovements(ISLAND_GRID, [moved], actors, 0, [end]);
    expect(movements).toHaveLength(1);
    // Playback is paced for the viewer (pacing.ts): join where recorded second 20 is shown.
    const pacing = paceMovement(movements[0]!.trace, 'sambar', 12);
    const wire = JSON.parse(JSON.stringify({ id: 'stream:3600', startWorldTime: 0, endWorldTime: 3600,
      elapsedWorldSeconds: displaySecondAt(pacing, 20), rate: 12, encounters: [], movements }));
    expect(isLiveEncounterFrame(wire)).toBe(true);
    const player = new LiveEncounterPlayer(); player.apply(wire, 100);
    const corner = player.poses(100).get('s')!.position;
    // Near the recorded legs (the observer wanders a route a few metres, naturalPath.ts) ...
    expect(Math.abs(corner.x - 100)).toBeLessThan(6); expect(Math.abs(corner.z - 50)).toBeLessThan(6);
    // ... and half-way through the first leg near it, not on a diagonal shortcut (25 m off it).
    const early = new LiveEncounterPlayer(); early.apply({ ...wire, elapsedWorldSeconds: displaySecondAt(pacing, 5) }, 100);
    expect(Math.abs(early.poses(100).get('s')!.position.z)).toBeLessThan(6);
    moved.movement!.samples[0]!.position.x = 77;
    expect(movements[0]!.trace.samples[0]!.position.x).toBe(0);
    expect(collectLiveMovements(ISLAND_GRID, [moved, event], actors, 0, [end])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved, { ...moved, id: 'move_2' }], actors, 0, [end])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved], actors, 0, [{ ...end, alive: false }])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved], actors, 0, [{ ...end, position: p(10) }])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved], actors, 3600, [end])).toEqual([]);
    expect(collectLiveMovements(ISLAND_GRID, [moved], new Map(), 0, [end])).toEqual([]);
  });
  it('uses pre-tick appearance for a killed prey and detaches traces from mutable world data', () => {
    const copy = structuredClone(event);
    const records = collectLiveEncounters(ISLAND_GRID, [copy], actors, 0);
    expect(records[0]).toMatchObject({ eventId: 'hunt_1', preySpecies: 'sambar', prey: { sizeRatio: 0.2 } });
    copy.encounter!.samples[0]!.prey.x = 99;
    expect(records[0]!.trace.samples[0]!.prey.x).toBe(5);
  });
  it('omits all ambiguous actor ownership instead of drawing one actor in two places', () => {
    expect(collectLiveEncounters(ISLAND_GRID, [event, { ...event, id: 'hunt_2' }], actors, 0)).toEqual([]);
    expect(collectLiveEncounters(ISLAND_GRID, [event], new Map(), 0)).toEqual([]);
    expect(collectLiveEncounters(ISLAND_GRID, [event], actors, 3600)).toEqual([]);
  });
  it('bounds duration and sample payloads', () => {
    const long = structuredClone(event); long.encounter!.samples[1]!.seconds = 3601;
    expect(collectLiveEncounters(ISLAND_GRID, [long], actors, 0)).toEqual([]);
    const large = structuredClone(event); large.encounter!.samples = Array(10_001).fill(event.encounter!.samples[0]);
    expect(collectLiveEncounters(ISLAND_GRID, [large], actors, 0)).toEqual([]);
  });
  it('bounds ordinary route actor counts and aggregate samples before transmission', () => {
    const { encounter: _encounter, ...base } = event;
    const entries = Array.from({ length: 2049 }, (_, i) => {
      const id = `s${i}`;
      return { actor: { id, speciesId: 'sambar', sizeRatio: 1, coatVariant: 0 },
        end: makeAgent('sambar', { id, position: p(0) }),
        event: { ...base, id: `move${i}`, type: 'moved', actors: [id],
          movement: { version: 1, actorId: id, startWorldTime: 0, destinationPatchId: 0, goal: 'wander', completed: true,
            samples: [{ seconds: 0, position: p(0) }] } } as WorldEvent };
    });
    const appearances = new Map(entries.map((e) => [e.actor.id, e.actor]));
    const end = entries.map((e) => e.end);
    expect(collectLiveMovements(ISLAND_GRID, entries.map((e) => e.event), appearances, 0, end)).toHaveLength(2048);
    const index = indexLiveMovements(ISLAND_GRID, entries.map((e) => e.event), appearances, 0, end);
    expect(index.size).toBe(2049);
    const defaultSelection = selectLiveMovements(index);
    expect(defaultSelection.some((m) => m.actor.id === 's2048')).toBe(false);
    const priority = selectLiveMovements(index, 's2048');
    expect(priority).toHaveLength(2048);
    expect(priority[0]).toEqual(index.get('s2048'));
    expect(new Set(priority.map((m) => m.actor.id)).size).toBe(priority.length);
    expect(selectLiveMovements(index, 'nonexistent')).toEqual(defaultSelection);
    expect(selectLiveMovements(index)).toEqual(defaultSelection); // No index reorder or mutation.
    for (const e of entries.slice(0, 17))
      e.event.movement!.samples = Array.from({ length: 2048 }, (_, seconds) => ({ seconds, position: p(0) }));
    expect(collectLiveMovements(ISLAND_GRID, entries.slice(0, 17).map((e) => e.event), appearances, 0, end)).toHaveLength(16);
    const large = indexLiveMovements(ISLAND_GRID, entries.slice(0, 17).map((e) => e.event), appearances, 0, end);
    const prioritizedLarge = selectLiveMovements(large, 's16');
    expect(prioritizedLarge).toHaveLength(16); expect(prioritizedLarge[0]!.actor.id).toBe('s16');
    expect(prioritizedLarge.reduce((n, m) => n + m.trace.samples.length, 0)).toBe(32_768);
    const player = new LiveEncounterPlayer();
    const frame = { id: 'one-hour', startWorldTime: 0, endWorldTime: 3600, rate: 12,
      elapsedWorldSeconds: 0, encounters: [], movements: selectLiveMovements(large) };
    expect(player.apply(JSON.parse(JSON.stringify(frame)), 0)).toBe(true);
    const existingPose = player.poses(10_000).get('s0');
    expect(player.apply({ ...frame, elapsedWorldSeconds: 100, movements: prioritizedLarge }, 10_000)).toBe(true);
    expect(player.elapsed(10_000)).toBe(120);
    expect(player.poses(10_000).get('s0')).toEqual(existingPose);
    expect(player.poses(10_000).get('s16')!.seconds).toBe(120);
  });
});
