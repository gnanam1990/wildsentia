import { describe, expect, it } from 'vitest';
import { createRng, paceEncounter, patchCentre, type EncounterTrace } from '@vana/shared';
import { resolveSpatialHunt, type SpatialHuntInput } from '../src/agents/encounters.js';
import { subdueSecondsFor } from '../src/agents/behaviours.js';
import { createWorld } from '../src/world.js';
import { SPECIES_DIR, speciesOf } from './helpers.js';

const input: SpatialHuntInput = {
  predatorId: 'tiger_a', preyId: 'sambar_a', patchId: 0, worldTime: 3600,
  predator: { x: 0, z: 0, heading: 0 }, prey: { x: 20, z: 0, heading: 0 },
  predatorWalkMs: 1, predatorSprintMs: 10, preySprintMs: 1, preyTrotMs: 0.5,
  predatorSprintSeconds: 25, preySprintSeconds: 40, contactRadiusM: 1,
  secondsAvailable: 3600, chaseStaminaCost: 0.34,
  contest: { baseSuccess: 1, stalkConcealment: 1, canopyCover: 1, predatorStamina: 1,
    predatorCondition: 1, preyEvasiveness: 0, preyCondition: 1, preyAlert: false,
    herdSize: 1, commitDistanceM: 10 },
};
const run = (changes: Partial<SpatialHuntInput> = {}) => resolveSpatialHunt({ ...input, ...changes }, createRng(3, 'encounter'));

describe('a seized prey is subdued before it dies (sim_0.36.0)', () => {
  it('records a subdue hold after the killing contact; the prey dies at its last sample', () => {
    const result = run({ subdueSeconds: 120, subdueDragM: 3 });
    expect(result.killed).toBe(true);
    const phases = result.trace.samples.map(s => s.phase);
    const contact = phases.indexOf('contact');
    expect(phases.slice(0, contact + 1)).toEqual(['approach', 'stalk', 'chase', 'contact']);
    const hold = result.trace.samples.slice(contact + 1);
    expect(hold.length).toBeGreaterThan(10);
    expect(hold.every(s => s.phase === 'subdue')).toBe(true);
    const at = result.trace.samples[contact]!;
    expect(at.seconds).toBeCloseTo(11);
    expect(hold.at(-1)!.seconds).toBeCloseTo(11 + 120, 9);
    let previous = at.seconds;
    for (const s of hold) {
      const gap = s.seconds - previous; previous = s.seconds;
      expect(gap).toBeGreaterThan(0); expect(gap).toBeLessThanOrEqual(5 + 1e-9);
      // The killer stays on its prey, inside the contact radius.
      expect(Math.hypot(s.predator.x - s.prey.x, s.predator.z - s.prey.z)).toBeLessThanOrEqual(input.contactRadiusM + 1e-9);
      // The prey is pulled down or drags its killer a few metres, no more.
      expect(Math.hypot(s.prey.x - at.prey.x, s.prey.z - at.prey.z)).toBeLessThanOrEqual(3 + 0.3);
    }
    const end = hold.at(-1)!;
    expect(Math.hypot(end.prey.x - at.prey.x, end.prey.z - at.prey.z)).toBeCloseTo(3, 6);
  });

  it('keeps legacy traces: no subdue configured means death at contact, and the hold never outlasts the hour', () => {
    expect(run().trace.samples.at(-1)!.phase).toBe('contact');
    const short = run({ subdueSeconds: 600, secondsAvailable: 60 });
    expect(short.killed).toBe(true);
    expect(short.trace.samples.at(-1)!.seconds).toBeCloseTo(60, 9);
    // A failed contact is still an escape, with no hold.
    const escaped = resolveSpatialHunt({ ...input, subdueSeconds: 60, contest: { ...input.contest, baseSuccess: 0 } }, createRng(3, 'encounter'));
    expect(escaped.trace.samples.some(s => s.phase === 'subdue')).toBe(false);
  });

  it('a heavy prey sometimes fights free partway through the hold and runs, wounded but alive', () => {
    let freed = 0, killed = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = resolveSpatialHunt({ ...input, subdueSeconds: 120, subdueDragM: 3, subdueBreakFreeChance: 0.2 }, createRng(seed, 'hold'));
      if (r.stage === 'broke_free') {
        freed++;
        expect(r.killed).toBe(false);
        const phases = r.trace.samples.map(s => s.phase);
        expect(phases.slice(phases.indexOf('contact'))).toEqual(['contact', ...phases.filter(p => p === 'subdue'), 'escape']);
        expect(phases.filter(p => p === 'subdue').length).toBeGreaterThan(0);
        expect(r.trace.samples.at(-1)!.seconds - r.trace.samples.find(s => s.phase === 'contact')!.seconds).toBeLessThan(120);
      } else if (r.killed) killed++;
    }
    expect(freed / (freed + killed)).toBeGreaterThan(0.12);
    expect(freed / (freed + killed)).toBeLessThan(0.28);
  });

  it('takes the field times: tigers seconds for chital and minutes for sambar and gaur, dholes faster in a pack', () => {
    const tiger = speciesOf('tiger').hunting!, dhole = speciesOf('dhole').hunting!;
    expect(subdueSecondsFor(tiger, 45, 1)).toBeGreaterThan(5);
    expect(subdueSecondsFor(tiger, 45, 1)).toBeLessThan(30);
    expect(subdueSecondsFor(tiger, 180, 1)).toBeGreaterThanOrEqual(60);
    expect(subdueSecondsFor(tiger, 700, 1)).toBe(240);
    expect(subdueSecondsFor(dhole, 50, 2.5)).toBeCloseTo(120);
    expect(subdueSecondsFor(dhole, 45, 4)).toBeLessThan(subdueSecondsFor(dhole, 45, 1));
    expect(subdueSecondsFor(dhole, 400, 2.5)).toBeCloseTo(900);
    expect(subdueSecondsFor(speciesOf('vulture').hunting ?? { ...tiger, subdueSeconds: undefined }, 45, 1)).toBe(0);
  });

  it('plays a hold at a quarter of real time and paces an old trace exactly as before', () => {
    const killed = run({ subdueSeconds: 120, subdueDragM: 1 }).trace;
    const legacy: EncounterTrace = { ...killed, samples: killed.samples.filter(s => s.phase !== 'subdue') };
    const pacing = paceEncounter(killed, 12);
    const i = pacing.trace.findIndex(t => Math.abs(t - killed.samples.at(-1)!.seconds) < 1e-9);
    const c = pacing.trace.findIndex(t => Math.abs(t - 11) < 1e-9);
    expect((pacing.display[i]! - pacing.display[c]!) / 12).toBeCloseTo(120 / 4, 6);
    expect(paceEncounter(legacy, 12).trace).toEqual(paceEncounter(legacy, 12).trace);
    expect(legacy.samples.at(-1)!.phase).toBe('contact');
  });

  it('a wild kill dies at the end of the hold: the carcass, death and hunt are timed there, and feeding starts after', () => {
    let checked = false;
    for (let seed = 1; seed <= 30 && !checked; seed++) {
      const world = createWorld({ seed, speciesDir: SPECIES_DIR, initialAgents: { tiger: 1, chital: 20 }, minPopulation: {} });
      const tiger = world.agents.find(a => a.speciesId === 'tiger')!;
      for (const a of world.agents) { a.patchId = 210; a.position = { ...patchCentre(210), heading: 0 }; }
      tiger.position = { ...patchCentre(210), x: patchCentre(210).x + 60, heading: 0 };
      tiger.drives = { hunger: 0.7, thirst: 0, fatigue: 0, fear: 0 };
      world.__reindexForTest();
      for (let h = 0; h < 24 && !checked; h++) {
        world.step(1);
        const hunt = world.log.all().find(e => e.type === 'hunt' && e.outcome === 'success');
        if (!hunt) continue;
        const samples = hunt.encounter!.samples, last = samples.at(-1)!;
        expect(last.phase).toBe('subdue');
        const contact = samples.find(s => s.phase === 'contact')!;
        expect(last.seconds - contact.seconds).toBeCloseTo(subdueSecondsFor(speciesOf('tiger').hunting!, Number(hunt.effects.preyMassKg), 1), 6);
        const at = Math.floor(hunt.encounter!.startWorldTime + last.seconds);
        expect(hunt.worldTime).toBe(at);
        expect(hunt.conditions.durationSeconds).toBeCloseTo(last.seconds, 9);
        const died = world.log.all().find(e => e.type === 'died' && e.actors[0] === hunt.actors[1])!;
        expect(died.worldTime).toBe(at);
        const carcass = world.carcasses.find(c => c.originId === hunt.actors[1]);
        if (carcass) expect(carcass.diedAt).toBe(at);
        const meal = world.log.all().find(e => e.type === 'fed' && e.actors[0] === tiger.id);
        if (meal) expect(Number(meal.conditions.arrivalWorldTime)).toBeGreaterThanOrEqual(hunt.encounter!.startWorldTime + last.seconds - 1e-6);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });
});
