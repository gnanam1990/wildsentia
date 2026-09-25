import { NUTRIENT_PER_KG_BIOMASS, positionInPatch, takeEdibleMass,
  type Agent, type Carcass, type Patch, type SpeciesConfig, type WorldPosition } from '@vana/shared';
import type { EventLog } from '../events/log.js';
import { HUNGER_PER_DAY, THIRST_PER_DAY, updateDrives } from './drives.js';
import { needsOf, needsProvisioning, inCareContact } from './needs.js';
import { travelToFamily, type CareVisit, type FamilyLocation } from './family.js';
import { navigate } from './navigation.js';
import { locateCarcass } from './spatial.js';

const samePoint = (a: WorldPosition | undefined, b: WorldPosition) => !!a && Math.hypot(a.x - b.x, a.z - b.z) <= 1e-8;
const radiusFor = (cfg: SpeciesConfig) => Math.max(0.35, cfg.body.shoulderHeightM * 0.65);
const need = (a: Agent) => Math.max(a.drives.hunger, a.drives.thirst);

export function packRecipientEligible(donor: Agent, recipient: Agent, cfg: SpeciesConfig,
  nursingParents: ReadonlySet<string>): boolean {
  const policy = cfg.social.cooperativeCare;
  return !!policy && donor.id !== recipient.id && donor.alive && recipient.alive
    && donor.speciesId === cfg.id && recipient.speciesId === cfg.id && !!donor.groupId
    && recipient.groupId === donor.groupId
    && (nursingParents.has(recipient.id) && recipient.sex === 'female' && !needsProvisioning(recipient, cfg)
      || recipient.ageDays >= policy.recipientFromDays && needsProvisioning(recipient, cfg));
}

export function packDonorEligible(donor: Agent, cfg: SpeciesConfig, nursingParents: ReadonlySet<string>): boolean {
  const policy = cfg.social.cooperativeCare;
  return !!policy && donor.alive && !!donor.groupId && donor.ageDays >= policy.donorFromDays
    && !needsProvisioning(donor, cfg) && !nursingParents.has(donor.id)
    && donor.drives.hunger < (donor.packFood ? 0.65 : 0.45) && donor.drives.thirst < 0.65 && donor.drives.fear < 0.5;
}

export function choosePackRecipient(donor: Agent, members: readonly Agent[], cfg: SpeciesConfig,
  nursingParents: ReadonlySet<string>): Agent | undefined {
  if (!packDonorEligible(donor, cfg, nursingParents)) return;
  const score = (a: Agent) => need(a) + (nursingParents.has(a.id) ? 0.25 : 0);
  return members.filter(a => packRecipientEligible(donor, a, cfg, nursingParents) && need(a) >= 0.15
    && (!donor.packFood || donor.packFood.recipientId === a.id && donor.packFood.packId === donor.groupId))
    .sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** Read-only route forecast. A recipient waits at most one decision and only for an already
 * loaded carrier that can reach its start point with useful contact time remaining. */
export function canWaitForPackFood(donor: Agent, target: FamilyLocation, cfg: SpeciesConfig,
  patches: Patch[], start: number, hours: number): boolean {
  const food = donor.packFood;
  if (!food || food.kg <= 0 || food.expiresAt <= start) return false;
  const copy = structuredClone(donor); updateDrives(copy, cfg, hours);
  if (copy.drives.hunger >= 0.65 || copy.drives.thirst >= 0.65 || copy.drives.fear >= 0.5) return false;
  const travel = navigate(copy, cfg, patches, target.patchId, 'deliver_pack_food', start, hours * 3600,
    false, target.position);
  return travel.trace.completed && travel.seconds <= hours * 3600 * 0.9
    && start + travel.seconds + 60 < food.expiresAt;
}

export interface PackCollection { visit: CareVisit; carcass: Carcass; recipient: Agent; start: number; end: number; settled?: boolean }
export interface PackDelivery { visit: CareVisit; recipient: Agent; recipientStart: FamilyLocation;
  sourceEventId: string; start: number; end: number; settled?: boolean }

export function beginPackCollection(donor: Agent, recipient: Agent, carcass: Carcass, cfg: SpeciesConfig,
  patches: Patch[], start: number, hours: number, log: EventLog): PackCollection | null {
  if (!cfg.social.cooperativeCare || donor.packFood || carcass.diedAt > start || carcass.pathogenLoad > cfg.diet.carrionTolerance) return null;
  const target = { patchId: carcass.patchId, position: { ...locateCarcass(carcass) } };
  return { visit: travelToFamily(donor, cfg, patches, target, 'collect_pack_food', start, hours, log, radiusFor(cfg)),
    carcass, recipient, start, end: start + hours * 3600 };
}

export function finishPackCollection(collection: PackCollection, cfg: SpeciesConfig, carcasses: readonly Carcass[],
  nursingParents: ReadonlySet<string>, log: EventLog): void {
  if (collection.settled) return;
  collection.settled = true;
  const { visit, carcass, recipient, start, end } = collection, donor = visit.parent, policy = cfg.social.cooperativeCare;
  if (!policy || donor.packFood || !packDonorEligible(donor, cfg, nursingParents)
    || !packRecipientEligible(donor, recipient, cfg, nursingParents) || !carcasses.includes(carcass)
    || donor.lastEncounterAt === start || donor.currentGoal !== 'collect_pack_food' || donor.state !== 'resting'
    || !samePoint(donor.position, visit.position) || !positionInPatch(carcass.position, carcass.patchId)
    || donor.patchId !== carcass.patchId || !positionInPatch(donor.position, donor.patchId)
    || Math.hypot(donor.position.x - carcass.position.x, donor.position.z - carcass.position.z) > radiusFor(cfg) + 1e-8
    || !(visit.arrival < end)) return;
  const availableSeconds = end - Math.max(start, visit.arrival, carcass.diedAt);
  const kg = takeEdibleMass(carcass.biomass, Math.min(donor.massKg * policy.capacityBodyFraction,
    donor.massKg * policy.collectionBodyFractionPerHour * availableSeconds / 3600));
  if (!(kg > 0)) return;
  const event = log.append({ type: 'pack_food_collected', worldTime: Math.floor(end), simVersion: '',
    patchId: donor.patchId, position: { ...donor.position }, actors: [donor.id, recipient.id, carcass.originId],
    goal: 'collect_pack_food', conditions: { sourceCarcassId: carcass.id, packId: donor.groupId!,
      arrivalWorldTime: visit.arrival, collectionSeconds: availableSeconds }, outcome: 'success', effects: { kg },
    causalParents: visit.routeId ? [visit.routeId] : [], confidence: 'authoritative' });
  donor.packFood = { kg, moistureLPerKg: policy.moistureLPerKg, sourceCarcassId: carcass.id, sourceActorId: carcass.originId,
    sourceEventId: event.id, collectedAt: end, expiresAt: end + policy.retentionHours * 3600,
    recipientId: recipient.id, packId: donor.groupId! };
}

export function beginPackDelivery(donor: Agent, recipient: Agent, target: FamilyLocation, cfg: SpeciesConfig,
  patches: Patch[], start: number, hours: number, log: EventLog): PackDelivery | null {
  if (!cfg.social.cooperativeCare || !donor.packFood || donor.packFood.collectedAt > start) return null;
  return { visit: travelToFamily(donor, cfg, patches, target, 'deliver_pack_food', start, hours, log),
    recipient, recipientStart: structuredClone(target), sourceEventId: donor.packFood.sourceEventId, start, end: start + hours * 3600 };
}

export function finishPackDelivery(delivery: PackDelivery, cfg: SpeciesConfig, patches: Patch[],
  nursingParents: ReadonlySet<string>, log: EventLog): void {
  if (delivery.settled) return;
  delivery.settled = true;
  const { visit, recipient, recipientStart, start, end } = delivery, donor = visit.parent, food = donor.packFood;
  const policy = cfg.social.cooperativeCare;
  if (!food || !policy || food.sourceEventId !== delivery.sourceEventId || food.packId !== donor.groupId
    || food.recipientId !== recipient.id || food.collectedAt > start
    || !packDonorEligible(donor, cfg, nursingParents)
    || !packRecipientEligible(donor, recipient, cfg, nursingParents) || donor.lastEncounterAt === start
    || recipient.lastEncounterAt === start || donor.currentGoal !== 'deliver_pack_food' || donor.state !== 'resting'
    || recipient.state !== 'resting' || recipient.patchId !== recipientStart.patchId
    || !samePoint(recipient.position, recipientStart.position) || !samePoint(donor.position, visit.position)
    || !inCareContact(donor, recipient, cfg)) return;
  const seconds = Math.max(0, Math.min(end, food.expiresAt) - Math.max(start, visit.arrival));
  const daily = needsOf(recipient, cfg);
  const foodDeficit = recipient.drives.hunger / HUNGER_PER_DAY * daily.foodKg;
  const waterDeficit = food.moistureLPerKg > 0 ? recipient.drives.thirst / THIRST_PER_DAY * daily.waterL / food.moistureLPerKg : 0;
  const kg = Math.min(food.kg, recipient.massKg * policy.deliveryBodyFractionPerHour * seconds / 3600,
    Math.max(foodDeficit, waterDeficit));
  if (!(kg > 0)) return;
  const water = kg * food.moistureLPerKg;
  recipient.drives.hunger = Math.max(0, recipient.drives.hunger - kg / daily.foodKg * HUNGER_PER_DAY);
  recipient.drives.thirst = Math.max(0, recipient.drives.thirst - water / daily.waterL * THIRST_PER_DAY);
  patches[recipient.patchId]!.soilNutrients += kg * NUTRIENT_PER_KG_BIOMASS;
  food.kg = Math.max(0, food.kg - kg);
  log.append({ type: 'pack_food_delivered', worldTime: Math.floor(Math.min(end, food.expiresAt)), simVersion: '',
    patchId: recipient.patchId, position: { ...recipient.position! }, actors: [recipient.id, donor.id], goal: 'deliver_pack_food',
    conditions: { sourceCarcassId: food.sourceCarcassId, packId: food.packId, arrivalWorldTime: visit.arrival,
      contactSeconds: seconds, role: nursingParents.has(recipient.id) ? 'nursing_parent' : 'young',
      donorX: donor.position!.x, donorZ: donor.position!.z }, outcome: 'success', effects: { kg, waterEquivalentL: water },
    causalParents: [food.sourceEventId, ...(visit.routeId ? [visit.routeId] : [])], confidence: 'authoritative' });
  if (food.kg === 0) delete donor.packFood;
}

/** Unassimilated stomach contents cannot remain indefinitely reserved. At the retention
 * deadline, or when the carrier urgently needs food, digestion moves its real biomass to soil.
 * This is a coarse digestive policy, not an instantaneous second hunt/feeding action. */
export function digestPackFood(donor: Agent, cfg: SpeciesConfig, patch: Patch, now: number, log: EventLog): boolean {
  const food = donor.packFood;
  if (!donor.alive || !food || !(food.kg > 0) || food.collectedAt > now
    || now < food.expiresAt && donor.drives.hunger < 0.65) return false;
  const daily = needsOf(donor, cfg), kg = food.kg;
  donor.drives.hunger = Math.max(0, donor.drives.hunger - kg / daily.foodKg * HUNGER_PER_DAY);
  donor.drives.thirst = Math.max(0, donor.drives.thirst - kg * food.moistureLPerKg / daily.waterL * THIRST_PER_DAY);
  patch.soilNutrients += kg * NUTRIENT_PER_KG_BIOMASS;
  log.append({ type: 'pack_food_digested', worldTime: now, simVersion: '', patchId: donor.patchId,
    position: { ...donor.position! }, actors: [donor.id], conditions: { sourceCarcassId: food.sourceCarcassId,
      reason: now >= food.expiresAt ? 'retention_elapsed' : 'carrier_energy_need' }, outcome: 'success',
    effects: { kg, waterEquivalentL: kg * food.moistureLPerKg }, causalParents: [food.sourceEventId], confidence: 'authoritative' });
  delete donor.packFood; return true;
}
