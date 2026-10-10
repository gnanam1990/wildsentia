import { isMovementTrace, isDrinkingActivity, positionInPatch, treeAnchorGeometry, recordedWaterAccessPositions, WATER_CONTACT_RADIUS_M,
  MAX_LIVE_MOVEMENTS, MAX_LIVE_MOVEMENT_SAMPLES,
  type Agent, type EncounterAppearance, type LiveEncounter, type LiveMovement, type WorldEvent, type WorldPosition } from '@vana/shared';

export function encounterAppearance(agent: Agent, adultMassKg: number): EncounterAppearance {
  return { id: agent.id, speciesId: agent.speciesId, sizeRatio: agent.massKg / adultMassKg,
    coatVariant: agent.traits.coatVariant, sex: agent.sex, lifeStage: agent.lifeStage };
}

/** A tree route is one saved decision, including an approach that never reached the trunk.
 * Do not infer a climb from a generic movement or from a sparse life-track position. */
export function isRecordedTreeClimb(event: WorldEvent): boolean {
  const trace = event.movement;
  if (event.type !== 'tree_climbed' || !trace || !isMovementTrace(trace)
    || event.actors.length !== 1 || event.actors[0] !== trace.actorId) return false;
  const anchor = treeAnchorGeometry(trace.destinationPatchId);
  const direction = event.conditions.direction;
  if (!anchor || event.conditions.treeAnchorId !== anchor.id
    || direction !== 'ascend' && direction !== 'descend'
    || !['local_threat', 'threat_gone', 'canopy_lost', 'urgent_need'].includes(String(event.conditions.reason))
    || event.goal !== (direction === 'ascend' ? 'flee' : 'rest')
    || event.outcome !== (trace.completed ? 'success' : 'interrupted')) return false;
  const vertical = event.effects.verticalDistanceM;
  if (typeof vertical !== 'number' || !Number.isFinite(vertical) || vertical < 0 || vertical > anchor.climbHeightM) return false;
  let recordedVertical = 0, previous = trace.samples[0]!.altitudeM ?? 0;
  for (const sample of trace.samples) {
    const altitude = sample.altitudeM ?? 0;
    if (altitude < 0 || altitude > anchor.climbHeightM
      || altitude > 0 && Math.hypot(sample.position.x - anchor.x, sample.position.z - anchor.z) > 1e-6) return false;
    const change = altitude - previous;
    if (direction === 'ascend' && change < -1e-6 || direction === 'descend' && change > 1e-6) return false;
    recordedVertical += Math.abs(change); previous = altitude;
  }
  return Math.abs(recordedVertical - vertical) <= 1e-6;
}

/** Keep one detached eligible route per actor for this hour, not a growing event history.
 * Wire caps apply at selection time, so they never discard a later followed actor's record. */
export function indexLiveMovements(
  events: readonly WorldEvent[], actors: ReadonlyMap<string, EncounterAppearance>, start: number,
  endActors: readonly Agent[],
  startPositions: ReadonlyMap<string, WorldPosition> = new Map(),
): Map<string, LiveMovement> {
  const excluded = new Set<string>();
  const uses = new Map<string, number>();
  for (const e of events) {
    if (e.encounter?.startWorldTime === start) {
      excluded.add(e.encounter.predatorId); excluded.add(e.encounter.preyId);
    }
    if (e.movement && e.movement.startWorldTime >= start && e.movement.startWorldTime < start + 3600)
      uses.set(e.movement.actorId, (uses.get(e.movement.actorId) ?? 0) + 1);
  }
  const end = new Map(endActors.map((a) => [a.id, a]));
  const result = new Map<string, LiveMovement>();
  for (const e of events) {
    const trace = e.movement;
    if (!trace || trace.startWorldTime !== start || !isMovementTrace(trace)
      || !(['moved', 'fled'].includes(e.type) || isRecordedTreeClimb(e)) || e.actors[0] !== trace.actorId
      || uses.get(trace.actorId) !== 1 || excluded.has(trace.actorId)) continue;
    const actor = actors.get(trace.actorId), final = end.get(trace.actorId);
    const position = trace.samples.at(-1)!.position;
    // Death, emigration or later unrecorded relocation would make holding this endpoint false.
    if (!actor || !final?.alive || final.state === 'emigrated' || final.state === 'dead'
      || !final.position || Math.hypot(final.position.x - position.x, final.position.z - position.z) > 1e-6
      || e.type === 'tree_climbed' && Math.abs((final.altitudeM ?? 0) - (trace.samples.at(-1)!.altitudeM ?? 0)) > 1e-6) continue;
    result.set(trace.actorId, { eventId: e.id, actor: { ...actor }, trace: structuredClone(trace) });
  }
  const drinks = events.filter((e) => e.type === 'drank' && e.worldTime >= start && e.worldTime <= start + 3600
    && typeof e.conditions.arrivalWorldTime === 'number' && e.conditions.arrivalWorldTime >= start
    && e.conditions.arrivalWorldTime < start + 3600);
  const drinkCounts = new Map<string, number>();
  for (const e of drinks) if (e.actors[0]) drinkCounts.set(e.actors[0], (drinkCounts.get(e.actors[0]) ?? 0) + 1);
  const samePlace = (a: WorldPosition | undefined, b: WorldPosition) => a !== undefined
    && Math.hypot(a.x - b.x, a.z - b.z) <= 1e-6;
  for (const e of drinks) {
    const id = e.actors[0]!, final = end.get(id), actor = actors.get(id);
    if (!actor || !final?.alive || ['dead', 'emigrated'].includes(final.state) || excluded.has(id)
      || drinkCounts.get(id) !== 1 || e.actors.length !== 1 || e.outcome !== 'success' || e.goal !== 'find_water'
      || !positionInPatch(e.position, e.patchId) || !samePlace(final.position, e.position)) continue;
    const arrival = e.conditions.arrivalWorldTime, duration = e.conditions.drinkingSeconds;
    if (typeof arrival !== 'number' || typeof duration !== 'number') continue;
    const endSeconds = arrival + duration - start, timestampRemainder = arrival + duration - e.worldTime;
    const activity = { type: 'drinking' as const, eventId: e.id, startSeconds: arrival - start,
      endSeconds: Math.min(3600, endSeconds), position: { ...e.position }, litres: e.effects.litres! };
    // A lake's source is on its shore (sim_0.38.0): any recorded access point of the patch.
    const sourced = recordedWaterAccessPositions(e.patchId)
      .some(source => e.conditions.sourceX === source.x && e.conditions.sourceZ === source.z);
    if (!isDrinkingActivity(activity) || endSeconds > 3600 + 1e-6 || timestampRemainder < -1e-6 || timestampRemainder >= 1 + 1e-6
      || !sourced
      || e.conditions.contactRadiusM !== WATER_CONTACT_RADIUS_M) continue;
    const movement = result.get(id);
    if (movement) {
      const last = movement.trace.samples.at(-1)!;
      if (!movement.trace.completed || movement.trace.goal !== 'find_water'
        || Math.abs(last.seconds - activity.startSeconds) > 1e-6 || !samePlace(last.position, activity.position)
        || !e.causalParents.includes(movement.eventId)) continue;
      movement.activity = activity;
    } else if (!uses.has(id) && activity.startSeconds === 0 && e.causalParents.length === 0
      && samePlace(startPositions.get(id), activity.position)) {
      result.set(id, { eventId: e.id, actor: { ...actor }, stationary: true, activity,
        trace: { version: 1, actorId: id, startWorldTime: start, destinationPatchId: e.patchId,
          goal: 'find_water', completed: true, samples: [{ seconds: 0, position: { ...startPositions.get(id)! } }] } });
    }
  }
  return result;
}

/** A watcher affects delivery order only. Coordinates, timestamps and outcomes never change. */
export function selectLiveMovements(
  index: ReadonlyMap<string, LiveMovement>, priorityActorId: string | null = null,
): LiveMovement[] {
  const result: LiveMovement[] = [];
  let samples = 0;
  const add = (movement: LiveMovement): void => {
    if (result.length >= MAX_LIVE_MOVEMENTS || samples + movement.trace.samples.length > MAX_LIVE_MOVEMENT_SAMPLES) return;
    result.push(movement); samples += movement.trace.samples.length;
  };
  const priority = priorityActorId === null ? undefined : index.get(priorityActorId);
  if (priority) add(priority);
  for (const movement of index.values()) {
    if (movement !== priority) add(movement);
    if (result.length >= MAX_LIVE_MOVEMENTS || samples >= MAX_LIVE_MOVEMENT_SAMPLES) break;
  }
  return result;
}

/** Compatibility helper for callers needing the default bounded frame only. */
export function collectLiveMovements(
  events: readonly WorldEvent[], actors: ReadonlyMap<string, EncounterAppearance>, start: number,
  endActors: readonly Agent[],
): LiveMovement[] {
  return selectLiveMovements(indexLiveMovements(events, actors, start, endActors));
}

/** Bound the wire payload. Ambiguous concurrent ownership is not turned into invented motion. */
export function collectLiveEncounters(
  events: readonly WorldEvent[], actors: ReadonlyMap<string, EncounterAppearance>, start: number,
): LiveEncounter[] {
  const candidates = events.filter((e) => e.type === 'hunt' && e.encounter?.startWorldTime === start);
  const uses = new Map<string, number>();
  for (const e of candidates) for (const id of [e.encounter!.predatorId, e.encounter!.preyId]) {
    uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const result: LiveEncounter[] = [];
  let samples = 0;
  for (const e of candidates) {
    const trace = e.encounter!;
    const predator = actors.get(trace.predatorId), prey = actors.get(trace.preyId);
    if (!predator || !prey || uses.get(predator.id) !== 1 || uses.get(prey.id) !== 1
      || trace.samples.length < 1 || trace.samples.at(-1)!.seconds > 3600
      || trace.samples.length > 10_000 || result.length >= 128 || samples + trace.samples.length > 100_000) continue;
    samples += trace.samples.length;
    result.push({ eventId: e.id, outcome: e.outcome, trace: structuredClone(trace),
      predatorSpecies: predator.speciesId, preySpecies: prey.speciesId, predator, prey });
  }
  return result;
}
