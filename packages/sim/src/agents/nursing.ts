import { positionInPatch, type Agent, type SpeciesConfig } from '@vana/shared';
import type { EventLog } from '../events/log.js';
import { locateAgent } from './spatial.js';
import { needsProvisioning } from './needs.js';

/** An intersecting opportunity, not a promise that either participant has arrived. */
export function nursingWindow(cfg: SpeciesConfig, start: number, end: number) {
  const policy = cfg.lifecycle.nursing;
  if (!policy || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // The engine normally steps hourly. A larger diagnostic step has at most its first
  // intersecting opportunity; it does not fabricate repeated feeds without intervening actions.
  let cycle = Math.floor(start / 86400);
  let opens = cycle * 86400 + policy.startHour * 3600;
  if (opens + policy.windowHours * 3600 <= start) { cycle++; opens += 86400; }
  const from = Math.max(start, opens), to = Math.min(end, opens + policy.windowHours * 3600);
  return from < to ? { cycle, start: from, end: to } : null;
}

export function nursingBudget(child: Agent, cycle: number) {
  const previous = child.nursingIntake;
  return previous?.cycle === cycle ? { ...previous }
    : { cycle, foodDays: 0, waterDays: 0, contactSeconds: 0, lastEnd: 0, completed: false };
}

export function nursingEligible(child: Agent, cfg: SpeciesConfig, start: number, end: number): boolean {
  if (!cfg.lifecycle.nursing) return true;
  const window = nursingWindow(cfg, start, end);
  return !!window && !nursingBudget(child, window.cycle).completed
    && nursingBudget(child, window.cycle).contactSeconds < cfg.lifecycle.nursing.dailyContactSeconds;
}

/** Existing snapshots cannot tell us an old birth site. Establish a new rendezvous at a
 * deterministic living dependent's current point, persist it and record that provenance.
 * No animal is moved, and existing valid sites are never overwritten. */
export function establishNursingSites(parent: Agent, children: readonly Agent[], cfg: SpeciesConfig,
  now: number, log: EventLog): void {
  if (!cfg.lifecycle.nursing || !parent.alive) return;
  const young = children.filter(c => c.alive && c.dependentOn === parent.id && c.speciesId === parent.speciesId
    && needsProvisioning(c, cfg)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const missing = young.filter(c => !c.nursingSite || !positionInPatch(c.nursingSite.position, c.nursingSite.patchId));
  if (!missing.length) return;
  const known = young.find(c => c.nursingSite && positionInPatch(c.nursingSite.position, c.nursingSite.patchId))?.nursingSite;
  const anchor = missing[0]!;
  const site = known ?? { patchId: anchor.patchId, position: { ...locateAgent(anchor) }, establishedAt: now, origin: 'established' as const };
  for (const child of missing) child.nursingSite = structuredClone(site);
  log.append({ type: 'nursing_site_established', worldTime: now, simVersion: '', patchId: site.patchId,
    position: { ...site.position }, actors: [parent.id, ...missing.map(c => c.id)],
    conditions: { species: parent.speciesId, reason: known ? 'joined_existing_site' : 'new_rendezvous_not_historical_birth' },
    outcome: 'success', effects: { dependants: missing.length }, causalParents: [], confidence: 'authoritative' });
}
