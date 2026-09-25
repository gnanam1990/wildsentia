import { describe, expect, it, vi } from 'vitest';
import { initialPosition, positionInPatch, type Agent } from '@vana/shared';
import { locateAgent, placeBeside } from '../src/agents/spatial.js';
import { createWorld } from '../src/world.js';
import { takeSnapshot, restoreSnapshot } from '../src/snapshot.js';
import { makeAgent, SPECIES_DIR } from './helpers.js';

const options = { seed: 43, speciesDir: SPECIES_DIR, initialAgents: { sambar: 3 }, minPopulation: {} };
describe('server-owned spatial state', () => {
  it('records the newborn location at birth, before any later movement or dependent placement', () => {
    const w = createWorld(options), mother = w.agents[0]!;
    mother.sex = 'female'; mother.pregnantSince = -w.species.get('sambar')!.lifecycle.gestationDays * 86400;
    mother.drives = { hunger: 0, thirst: 0, fatigue: 1, fear: 0 };
    const captured = new Map<string, unknown>(), append = w.log.append.bind(w.log);
    const spy = vi.spyOn(w.log, 'append').mockImplementation((e) => {
      if (e.type === 'born') captured.set(e.actors[0]!, { ...w.agents.find((a) => a.id === e.actors[0])!.position! });
      return append(e);
    });
    w.step(1); spy.mockRestore();
    const births = w.log.all().filter((e) => e.type === 'born');
    expect(births.length).toBeGreaterThan(0);
    for (const birth of births) {
      expect(positionInPatch(birth.position, birth.patchId)).toBe(true);
      expect(birth.position).toEqual(captured.get(birth.actors[0]!));
      const child = w.agents.find((a) => a.id === birth.actors[0])!;
      expect(birth.position).not.toBe(child.position);
      child.position = initialPosition(child.id, 20); child.patchId = 20;
      expect(birth.position).toEqual(captured.get(child.id));
    }
  });
  it('does not overwrite a dependent prey escape endpoint this tick or the next', () => {
    const world = createWorld({ ...options, initialAgents: { sambar: 2 } });
    const [mother, child] = world.agents;
    Object.assign(child!, { dependentOn: mother!.id, ageDays: 1, lifeStage: 'newborn',
      lastEncounterAt: 0, drives: { hunger: 0, thirst: 0, fatigue: 1, fear: 0 } });
    const escaped = { ...child.position! };
    world.step(1); expect(child!.position).toEqual(escaped);
    world.step(1); expect(child!.position).toEqual(escaped);
  });
  it('preserves valid local positions, repairing moved-patch or invalid values', () => {
    const a = makeAgent('sambar', { position: { x: 5, z: 6, heading: 0.4 } });
    expect(locateAgent(a)).toEqual(a.position);
    a.patchId = 1;
    expect(positionInPatch(locateAgent(a), 1)).toBe(true);
    a.position = { x: NaN, z: 0, heading: 0 };
    expect(locateAgent(a)).toEqual(initialPosition(a.id, 1));
  });
  it('keeps contact anchors in bounds and facing the target', () => {
    const a = makeAgent('sambar');
    const target = { x: 149.9, z: 149.9, heading: 0 };
    placeBeside(a, target, 2);
    expect(positionInPatch(a.position, 0)).toBe(true);
    expect(Math.hypot(a.position!.x-target.x, a.position!.z-target.z)).toBeLessThanOrEqual(2.01);
    expect(a.position!.heading).toBe(Math.atan2(target.x-a.position!.x, target.z-a.position!.z));
  });
  it('does not snap a first-listed dependant to the parent’s patch or final position', () => {
    const world = createWorld({ ...options, initialAgents: { sambar: 2 } });
    const [child, mother] = world.agents;
    Object.assign(child!, { dependentOn: mother!.id, ageDays: 1, lifeStage: 'newborn',
      drives: { hunger: 0, thirst: 0, fatigue: 1, fear: 0 } });
    const before = { ...child!.position! }, patch = child!.patchId;
    world.step(1);
    expect(child!.position).toEqual(before); expect(child!.patchId).toBe(patch);
  });
  it('preserves the exact death position on the carcass and across snapshot restore', () => {
    const w = createWorld(options);
    const a = w.agents[0]!;
    const p = initialPosition(a.id, a.patchId); p.x += 2; p.heading = 1;
    a.position = p; a.drives.hunger = 1;
    w.step(1);
    const corpse = w.carcasses.find((c) => c.originId === a.id)!;
    expect(corpse.position).toEqual(p);
    expect(corpse.position).not.toBe(a.position);
    for (const type of ['died', 'carcass_created']) {
      const event = w.log.all().find((e) => e.type === type && e.actors.includes(a.id))!;
      expect(event.position).toEqual(p);
      expect(event.position).not.toBe(corpse.position);
    }
    const restored = restoreSnapshot(takeSnapshot(w), options);
    expect(restored.carcasses.find((c) => c.originId === a.id)?.position).toEqual(p);
  });
  it('migrates legacy snapshots deterministically without modifying their recorded object', () => {
    const w = createWorld(options); const snapshot = takeSnapshot(w);
    for (const a of snapshot.agents) delete a.position;
    const before = JSON.stringify(snapshot);
    const a = restoreSnapshot(snapshot, options); const b = restoreSnapshot(snapshot, options);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(a.agents.every((agent) => positionInPatch(agent.position, agent.patchId))).toBe(true);
    expect(a.agents).toEqual(b.agents);
  });
  it('continues spatial state identically after restart', () => {
    const a = createWorld(options); for (let i = 0; i < 20; i++) a.step(1);
    const b = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(a))), options);
    for (let i = 0; i < 20; i++) { a.step(1); b.step(1); }
    const points = (agents: Agent[]) => agents.map((agent) => [agent.id, agent.position]);
    expect(points(a.agents)).toEqual(points(b.agents));
  });
});
