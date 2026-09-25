import { describe, expect, it } from 'vitest';
import { NUTRIENT_PER_KG_BIOMASS, carcassMass, edibleMass, isMovementTrace, takeEdibleMass, type Agent } from '@vana/shared';
import { EventLog } from '../src/events/log.js';
import { buildGrid } from '../src/grid.js';
import { makeCarcass, decayCarcass } from '../src/fields/decomposition.js';
import { totalNutrients } from '../src/fields/nutrients.js';
import { beginPackCollection, finishPackCollection, beginPackDelivery, finishPackDelivery, digestPackFood,
  choosePackRecipient, packDonorEligible, canWaitForPackFood, packRecipientEligible } from '../src/agents/packCare.js';
import { needsOf } from '../src/agents/needs.js';
import { HUNGER_PER_DAY, THIRST_PER_DAY } from '../src/agents/drives.js';
import { parseSpecies } from '../src/config/loader.js';
import { createWorld, SIM_VERSION } from '../src/world.js';
import { takeSnapshot, restoreSnapshot, upgradeV12Snapshot } from '../src/snapshot.js';
import { makeAgent, SPECIES_DIR, speciesOf } from './helpers.js';
import { asLegacySnapshot } from './legacySnapshot.js';

function fixture() {
  const cfg = structuredClone(speciesOf('dhole')), patches = buildGrid(1), log = new EventLog(1, SIM_VERSION);
  for (const p of patches) p.habitat = 'grassland';
  const donor = makeAgent('dhole', { id: 'helper', groupId: 'pack', position: { x: -100, z: 0, heading: 0 },
    drives: { hunger: 0.1, thirst: 0.1, fear: 0, fatigue: 0 } });
  const recipient = makeAgent('dhole', { id: 'mother', groupId: 'pack', position: { x: 100, z: 0, heading: 0 },
    drives: { hunger: 0.75, thirst: 0.3, fear: 0, fatigue: 0 } });
  const carcass = makeCarcass('source', 'prey', 'sambar', 0, 0, 'natural', 'authoritative', 20);
  carcass.position = { x: 0, z: 0, heading: 0 };
  const nursing = new Set([recipient.id]), bodies = [carcass], agents = [donor, recipient];
  const nutrient = () => totalNutrients(patches, agents, { imported: 0, exported: 0 }, bodies);
  const collect = (hours = 1) => {
    const c = beginPackCollection(donor, recipient, carcass, cfg, patches, 0, hours, log)!;
    finishPackCollection(c, cfg, bodies, nursing, log); return c;
  };
  const deliver = (hours = 1) => beginPackDelivery(donor, recipient,
    { patchId: recipient.patchId, position: { ...recipient.position! } }, cfg, patches, 3600, hours, log)!;
  return { cfg, patches, log, donor, recipient, carcass, nursing, bodies, agents, nutrient, collect, deliver };
}

describe('source-backed cooperative food care', () => {
  it('never withdraws negative organ mass through floating-point rounding', () => {
    const mass = 23 / 997, requested = mass / 3;
    const biomass = { muscle: mass, organ: 0, hide: 0, bone: 0 };
    expect(takeEdibleMass(biomass, requested)).toBe(requested);
    expect(biomass.organ).toBe(0);
    expect(biomass.muscle).toBe(mass - requested);
  });
  it('takes actual carcass biomass only after arrival, without also crediting donor reserves or soil', () => {
    const s = fixture(), baseline = s.nutrient(), before = structuredClone(s.donor.drives), soil = s.patches[0]!.soilNutrients;
    const collection = s.collect();
    expect(s.donor.packFood!.kg).toBeGreaterThan(0);
    expect(s.donor.packFood!.kg).toBeLessThan(s.donor.massKg * 0.05);
    expect(carcassMass(s.carcass.biomass) + s.donor.packFood!.kg).toBeCloseTo(20, 12);
    expect(s.donor.drives).toEqual(before); expect(s.patches[0]!.soilNutrients).toBe(soil);
    expect(s.nutrient()).toBeCloseTo(baseline, 8);
    const event = s.log.all().find(e => e.type === 'pack_food_collected')!;
    expect(event.causalParents).toEqual([collection.visit.routeId]);
    expect(isMovementTrace(s.log.all().find(e => e.id === collection.visit.routeId)!.movement)).toBe(true);
    expect(event.worldTime).toBe(3600); expect(s.donor.packFood!.sourceEventId).toBe(event.id);
    const after = structuredClone(s.donor.packFood);
    finishPackCollection(collection, s.cfg, s.bodies, s.nursing, s.log);
    expect(s.donor.packFood).toEqual(after);
  });
  it('does not collect or transfer through missing contact time', () => {
    const s = fixture(), c = s.collect(0.001);
    expect(c.visit.arrival).toBe(Infinity); expect(s.donor.packFood).toBeUndefined();
    expect(carcassMass(s.carcass.biomass)).toBe(20);
    s.collect(); const food = structuredClone(s.donor.packFood), d = s.deliver(0.001);
    finishPackDelivery(d, s.cfg, s.patches, s.nursing, s.log);
    expect(s.donor.packFood).toEqual(food);
  });
  it('rejects a future or too-high-pathogen source rather than collecting food before it exists', () => {
    const s = fixture(); s.carcass.diedAt = 1;
    expect(beginPackCollection(s.donor, s.recipient, s.carcass, s.cfg, s.patches, 0, 1, s.log)).toBeNull();
    s.carcass.diedAt = 0; s.carcass.pathogenLoad = 1;
    expect(beginPackCollection(s.donor, s.recipient, s.carcass, s.cfg, s.patches, 0, 1, s.log)).toBeNull();
  });
  it('delivers exact food and model moisture at contact, caps the recipient rate and cannot double-spend a visit', () => {
    const s = fixture(); s.collect(); const baseline = s.nutrient(), amount = s.donor.packFood!.kg;
    const before = { ...s.recipient.drives }, d = s.deliver();
    finishPackDelivery(d, s.cfg, s.patches, s.nursing, s.log);
    const event = s.log.all().find(e => e.type === 'pack_food_delivered')!;
    expect(event).toBeDefined(); expect(event.effects.kg).toBeGreaterThan(0);
    expect(event.effects.kg).toBeLessThanOrEqual(amount);
    expect(event.causalParents).toEqual([s.log.all().find(e => e.type === 'pack_food_collected')!.id, d.visit.routeId]);
    const kg = Number(event.effects.kg), needs = needsOf(s.recipient, s.cfg);
    expect(before.hunger - s.recipient.drives.hunger).toBeCloseTo(kg / needs.foodKg * HUNGER_PER_DAY);
    expect(before.thirst - s.recipient.drives.thirst).toBeCloseTo(kg * 0.65 / needs.waterL * THIRST_PER_DAY);
    expect(s.nutrient()).toBeCloseTo(baseline, 8);
    const settled = structuredClone(s.recipient);
    finishPackDelivery(d, s.cfg, s.patches, s.nursing, s.log); expect(s.recipient).toEqual(settled);
  });
  it.each(['donor_dead', 'recipient_dead', 'donor_interrupted', 'recipient_interrupted', 'recipient_moved',
    'donor_moved', 'wrong_pack', 'wrong_target', 'newborn', 'moving_recipient'])('rejects delivery after %s', reason => {
    const s = fixture(); s.collect(); const d = s.deliver();
    if (reason === 'donor_dead') s.donor.alive = false;
    if (reason === 'recipient_dead') s.recipient.alive = false;
    if (reason === 'donor_interrupted') s.donor.lastEncounterAt = 3600;
    if (reason === 'recipient_interrupted') s.recipient.lastEncounterAt = 3600;
    if (reason === 'recipient_moved') s.recipient.position!.x += 0.01;
    if (reason === 'donor_moved') s.donor.position!.x += 0.01;
    if (reason === 'wrong_pack') s.recipient.groupId = 'stranger';
    if (reason === 'wrong_target') s.donor.packFood!.recipientId = 'other';
    if (reason === 'newborn') { s.nursing.clear(); s.recipient.ageDays = 2; }
    if (reason === 'moving_recipient') s.recipient.state = 'travelling';
    const before = structuredClone(s.recipient.drives), food = structuredClone(s.donor.packFood);
    finishPackDelivery(d, s.cfg, s.patches, s.nursing, s.log);
    expect(s.recipient.drives).toEqual(before); expect(s.donor.packFood).toEqual(food);
    expect(s.log.all().some(e => e.type === 'pack_food_delivered')).toBe(false);
  });
  it('has one bounded cargo per carrier and cannot take the same material from a depleted source', () => {
    const s = fixture(); s.carcass.biomass = { muscle: 0.01, organ: 0.01, hide: 0, bone: 0 };
    s.collect(); expect(s.donor.packFood!.kg).toBeCloseTo(0.02);
    expect(edibleMass(s.carcass.biomass)).toBe(0);
    expect(beginPackCollection(s.donor, s.recipient, s.carcass, s.cfg, s.patches, 3600, 1, s.log)).toBeNull();
    const other = { ...s.donor, id: 'other' }; delete other.packFood;
    const c = beginPackCollection(other, s.recipient, s.carcass, s.cfg, s.patches, 0, 1, s.log)!;
    finishPackCollection(c, s.cfg, s.bodies, s.nursing, s.log); expect(other.packFood).toBeUndefined();
  });
  it('self-digests expired or urgently needed cargo exactly once, conserving its biomass', () => {
    for (const urgent of [false, true]) {
      const s = fixture(); s.collect(); const baseline = s.nutrient(), food = s.donor.packFood!;
      if (urgent) s.donor.drives.hunger = 0.8;
      const time = urgent ? 3600 : food.expiresAt;
      expect(digestPackFood(s.donor, s.cfg, s.patches[0]!, time, s.log)).toBe(true);
      expect(s.donor.packFood).toBeUndefined(); expect(s.nutrient()).toBeCloseTo(baseline, 8);
      expect(digestPackFood(s.donor, s.cfg, s.patches[0]!, time, s.log)).toBe(false);
      expect(s.log.all().filter(e => e.type === 'pack_food_digested')).toHaveLength(1);
    }
  });
  it('does not promise a wait for an empty, late, exhausted or unreachable carrier', () => {
    const s = fixture(), target = { patchId: 0, position: { ...s.recipient.position! } };
    expect(canWaitForPackFood(s.donor, target, s.cfg, s.patches, 0, 1)).toBe(false);
    s.collect(); expect(canWaitForPackFood(s.donor, target, s.cfg, s.patches, 3600, 1)).toBe(true);
    const position = structuredClone(s.donor.position);
    s.donor.drives.hunger = 0.649;
    expect(canWaitForPackFood(s.donor, target, s.cfg, s.patches, 3600, 1)).toBe(false);
    s.donor.drives.hunger = 0.1; s.cfg.locomotion.walkMs = 0.00001;
    expect(canWaitForPackFood(s.donor, target, s.cfg, s.patches, 3600, 1)).toBe(false);
    expect(s.donor.position).toEqual(position);
  });
  it('gates pack identity, donor maturity, source configuration and recipient development', () => {
    const s = fixture(); expect(choosePackRecipient(s.donor, s.agents, s.cfg, s.nursing)).toBe(s.recipient);
    s.donor.ageDays = 10; expect(packDonorEligible(s.donor, s.cfg, s.nursing)).toBe(false);
    s.donor.ageDays = 900; s.nursing.clear(); s.recipient.ageDays = 20.99;
    expect(packRecipientEligible(s.donor, s.recipient, s.cfg, s.nursing)).toBe(false);
    s.recipient.ageDays = 21;
    expect(packRecipientEligible(s.donor, s.recipient, s.cfg, s.nursing)).toBe(true);
    const invalid = structuredClone(s.cfg); invalid.social.structure = 'solitary'; expect(() => parseSpecies(invalid)).toThrow();
    invalid.social.structure = 'pack'; invalid.social.cooperativeCare!.donorFromDays = 1; expect(() => parseSpecies(invalid)).toThrow();
  });
  it('keeps ingesta separate from muscle, edible to scavengers, and decaying into soil', () => {
    const s = fixture(); s.carcass.biomass = { muscle: 0, organ: 0, hide: 0, bone: 1, ingesta: 0.5 };
    s.carcass.originalMassKg = 1.5;
    expect(edibleMass(s.carcass.biomass)).toBe(0.5);
    const baseline = s.nutrient(); decayCarcass(s.carcass, s.patches[0]!, 1, 'wet');
    expect(s.carcass.biomass.ingesta).toBeLessThan(0.5); expect(s.nutrient()).toBeCloseTo(baseline, 8);
    const available = edibleMass(s.carcass.biomass); expect(takeEdibleMass(s.carcass.biomass, 2)).toBe(available);
    expect(s.carcass.biomass.bone).toBeGreaterThan(0); expect(edibleMass(s.carcass.biomass)).toBe(0);
  });
});

describe('authoritative pack delivery', () => {
  const options = { seed: 5, speciesDir: SPECIES_DIR, initialAgents: { dhole: 3 }, minPopulation: {} };
  function worldFixture() {
    const world = createWorld(options), [donor, mother, child] = world.agents;
    for (const p of world.patches) p.habitat = 'grassland';
    for (const a of world.agents) Object.assign(a, { groupId: donor!.groupId, patchId: 0,
      pregnantSince: null, ageDays: 900, drives: { hunger: 0.1, thirst: 0.1, fear: 0, fatigue: 0 } });
    donor!.position = { x: -100, z: 0, heading: 0 }; donor!.sex = 'male';
    mother!.position = { x: 100, z: 0, heading: 0 }; mother!.sex = 'female'; mother!.offspringIds = [child!.id];
    mother!.drives.hunger = 0.74;
    Object.assign(child!, { ageDays: 3, lifeStage: 'newborn', massKg: 2, dependentOn: mother!.id, motherId: mother!.id,
      position: { x: 100.1, z: 0, heading: 0 } });
    const source = makeCarcass('fixture-source', 'prey', 'sambar', 0, 0, 'natural', 'authoritative', 100);
    source.position = { x: 0, z: 0, heading: 0 }; world.carcasses.push(source);
    return { world, donor: donor!, mother: mother!, child: child! };
  }
  it('collects in one decision, travels/delivers in the next, and resumes identically from in-transit snapshots', () => {
    const s = worldFixture(), baseline = s.world.totalNutrients(); s.world.step(1);
    expect(s.donor.packFood).toBeDefined(); expect(s.world.log.all().some(e => e.type === 'pack_food_delivered')).toBe(false);
    const snapshot = takeSnapshot(s.world), restored = restoreSnapshot(snapshot, options); s.world.log.take();
    s.world.step(1); restored.step(1);
    expect(restored.agents).toEqual(s.world.agents); expect(restored.log.all()).toEqual(s.world.log.all());
    const delivery = s.world.log.all().find(e => e.type === 'pack_food_delivered')!;
    expect(delivery).toBeDefined(); expect(delivery.actors).toEqual([s.mother.id, s.donor.id]);
    expect(delivery.worldTime).toBe(7200);
    expect(s.world.totalNutrients()).toBeCloseTo(baseline, 7);
    for (let i = 0; i < 24; i++) { s.world.step(1); restored.step(1); }
    expect(restored.agents).toEqual(s.world.agents); expect(restored.log.all()).toEqual(s.world.log.all());
    expect(s.world.totalNutrients()).toBeCloseTo(baseline, 7);
  });
  it('transfers a dead carrier parcel into its carcass, not lost or counted twice', () => {
    const s = worldFixture(); s.world.step(1); const kg = s.donor.packFood!.kg, baseline = s.world.totalNutrients();
    s.donor.ageDays = s.world.species.get('dhole')!.lifecycle.maxAgeDays;
    s.world.step(1);
    const corpse = s.world.carcasses.find(c => c.originId === s.donor.id)!;
    expect(corpse.biomass.ingesta).toBeCloseTo(kg); expect(s.donor.packFood).toBeUndefined();
    expect(s.world.totalNutrients()).toBeCloseTo(baseline, 7);
    expect(s.world.log.all().find(e => e.type === 'carcass_created' && e.actors.includes(s.donor.id))!.effects.ingestaKg).toBe(kg);
  });
  it('exports carried biomass when a loaded independent animal emigrates', () => {
    const world = createWorld({ ...options, initialAgents: { dhole: 1 }, landscape: { regional: { dhole: 0 }, exchangePerDay: 24 } });
    const a = world.agents[0]!; a.patchId = 0; a.position = { x: 0, z: 0, heading: 0 }; a.pregnantSince = null;
    a.drives = { hunger: 0, thirst: 0, fatigue: 1, fear: 0 };
    a.packFood = { kg: 0.5, moistureLPerKg: 0.65, collectedAt: 0, expiresAt: 36000, sourceActorId: 'prey',
      sourceCarcassId: 'source', sourceEventId: 'fixture-collection', recipientId: 'missing', packId: a.groupId! };
    world.species.get('dhole')!.locomotion.walkMs = 0.0001;
    const baseline = world.totalNutrients(); world.step(1);
    expect(a.state).toBe('emigrated'); expect(world.ledger.exported).toBeCloseTo((a.massKg + 0.5) * NUTRIENT_PER_KG_BIOMASS);
    expect(world.totalNutrients()).toBeCloseTo(baseline, 7);
  });
  it('explicitly upgrades v0.12 without inventing parcels or editing old state', () => {
    const s = worldFixture(), old = asLegacySnapshot(takeSnapshot(s.world), 'sim_0.12.0'), before = structuredClone(old);
    expect(() => restoreSnapshot(old, options)).toThrow(/version/);
    const upgraded = upgradeV12Snapshot(old); expect(upgraded.simVersion).toBe(SIM_VERSION);
    expect(upgraded.agents.every(a => !a.packFood)).toBe(true); expect(old).toEqual(before);
    expect(() => upgradeV12Snapshot({ ...old, simVersion: 'sim_0.11.0' })).toThrow();
  });
});
