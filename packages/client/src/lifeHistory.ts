import { positionInPatch } from '@vana/shared';
import { isRecordedEncounter, type RecordedEncounter } from './encounterReplay.js';
import { validNextCursor } from './historyCursor.js';
import { isRecordedClimb, type Life, type LifeMoment, type LifeTrackPoint } from './replay.js';

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** One explicit, checkpointed encounter; no synthetic whole-life track or inferred biography. */
export async function loadSelectedEncounter(id: string, eventId: string, signal: AbortSignal): Promise<Life> {
  signal.throwIfAborted();
  const response = await fetch(`/api/animals/${encodeURIComponent(id)}/encounters/${encodeURIComponent(eventId)}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error('Selected recording unavailable in the saved checkpoint.');
  const p: unknown = await response.json(); signal.throwIfAborted();
  if (!record(p) || p.id !== id || p.source !== 'checkpoint' || p.scope !== 'encounter'
    || !whole(p.asOfWorldTime) || !whole(p.nextEventSequence) || typeof p.speciesId !== 'string' || !p.speciesId
    || typeof p.alive !== 'boolean' || !whole(p.bornAt) || p.bornAt > p.asOfWorldTime
    || p.departedAt !== null && (!whole(p.departedAt) || p.departedAt > p.asOfWorldTime)
    || !isRecordedEncounter(p.encounter) || p.encounter.eventId !== eventId
    || ![p.encounter.trace.predatorId, p.encounter.trace.preyId].includes(id)
    || p.encounter.trace.startWorldTime < 0
    || p.encounter.trace.startWorldTime + p.encounter.trace.samples.at(-1)!.seconds > p.asOfWorldTime + 1)
    throw new Error('Selected event has no valid paired recording in this checkpoint.');
  return { id, speciesId: p.speciesId, alive: p.alive, bornAt: p.bornAt, departedAt: p.departedAt,
    track: [], moments: [], encounters: [p.encounter] };
}

/** Fetch one retained, actor-scoped tree route; never manufacture altitude from the life track. */
export async function loadSelectedClimb(id: string, eventId: string, signal: AbortSignal): Promise<Life> {
  signal.throwIfAborted();
  const response = await fetch(`/api/animals/${encodeURIComponent(id)}/movements/${encodeURIComponent(eventId)}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error('Selected tree recording unavailable in the saved checkpoint.');
  const p: unknown = await response.json(); signal.throwIfAborted();
  if (!record(p) || p.id !== id || p.source !== 'checkpoint' || p.scope !== 'movement'
    || !whole(p.asOfWorldTime) || !whole(p.nextEventSequence)
    || !['langur', 'squirrel'].includes(String(p.speciesId))
    || typeof p.alive !== 'boolean' || !whole(p.bornAt) || p.bornAt > p.asOfWorldTime
    || p.departedAt !== null && (!whole(p.departedAt) || p.departedAt > p.asOfWorldTime)
    || !isRecordedClimb(p.movement) || p.movement.eventId !== eventId || p.movement.trace.actorId !== id
    || p.movement.trace.startWorldTime + p.movement.trace.samples.at(-1)!.seconds > p.asOfWorldTime + 1)
    throw new Error('Selected event has no valid tree recording in this checkpoint.');
  return { id, speciesId: p.speciesId as string, alive: p.alive, bornAt: p.bornAt, departedAt: p.departedAt,
    track: [], moments: [], climbs: [p.movement] };
}
function trackPoint(v: unknown, until: number): v is LifeTrackPoint {
  if (!record(v) || !whole(v.worldTime) || v.worldTime > until || !whole(v.patchId) || v.patchId >= 400
    || typeof v.state !== 'string' || typeof v.goal !== 'string' || !record(v.drives)) return false;
  return ['hunger', 'thirst', 'fear', 'fatigue'].every(k => typeof (v.drives as Record<string, unknown>)[k] === 'number'
    && Number.isFinite((v.drives as Record<string, number>)[k]))
    && (v.position === undefined || positionInPatch(v.position, v.patchId))
    && (v.altitudeM === undefined || typeof v.altitudeM === 'number' && Number.isFinite(v.altitudeM)
      && v.altitudeM >= 0 && v.altitudeM <= 2_000 && positionInPatch(v.position, v.patchId));
}

/** All moment pages must succeed before replay can start. Trace memory stays bounded to recent
 * recordings plus an explicitly requested older event; the retained-history browser selects any age. */
export async function loadLifeHistory(id: string, options: {
  signal: AbortSignal; selectedEventId?: string | undefined; progress?: (pages: number, moments: number) => void;
}): Promise<Life> {
  const path = `/api/animals/${encodeURIComponent(id)}/life`;
  let url = path, biography: Life | null = null, boundary: { time: number; sequence: number } | null = null;
  const moments: LifeMoment[] = [], recent: RecordedEncounter[] = [], cursors = new Set<string>(), momentIds = new Set<string>();
  let selected: RecordedEncounter | null = null, pages = 0, lastTime = -1;
  while (true) {
    options.signal.throwIfAborted();
    const response = await fetch(url, { signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new Error('Life history unavailable; restart the replay.');
    const p: unknown = await response.json(); options.signal.throwIfAborted();
    if (!record(p) || p.id !== id || p.source !== 'checkpoint' || !whole(p.asOfWorldTime) || !whole(p.nextEventSequence)
      || !validNextCursor(p.nextCursor) || !Array.isArray(p.moments) || p.moments.length > 32
      || !Array.isArray(p.encounters) || p.encounters.length > 32) throw new Error('Invalid life-history page.');
    if (boundary && (p.asOfWorldTime !== boundary.time || p.nextEventSequence !== boundary.sequence)) throw new Error('Mixed life-history checkpoints.');
    if (!biography) {
      if (typeof p.speciesId !== 'string' || !p.speciesId || typeof p.alive !== 'boolean' || !whole(p.bornAt)
        || p.departedAt !== null && (!whole(p.departedAt) || p.departedAt > p.asOfWorldTime)
        || !Array.isArray(p.track) || p.track.length > 2002) throw new Error('Invalid life biography.');
      let time = -1;
      for (const point of p.track) {
        if (!trackPoint(point, p.asOfWorldTime) || point.worldTime <= time) throw new Error('Invalid life track.');
        time = point.worldTime;
      }
      biography = { id, speciesId: p.speciesId, alive: p.alive, bornAt: p.bornAt, departedAt: p.departedAt,
        track: p.track as LifeTrackPoint[], moments: [], encounters: [] };
      boundary = { time: p.asOfWorldTime, sequence: p.nextEventSequence };
    } else if ('track' in p || 'alive' in p || 'speciesId' in p) throw new Error('Biography repeated on a continuation.');
    for (const line of p.moments) {
      if (!record(line) || typeof line.eventId !== 'string' || !line.eventId || typeof line.text !== 'string'
        || !whole(line.worldTime) || line.worldTime > p.asOfWorldTime || line.worldTime < lastTime
        || momentIds.has(line.eventId)) throw new Error('Invalid life moment ordering.');
      momentIds.add(line.eventId); lastTime = line.worldTime;
      moments.push({ eventId: line.eventId, worldTime: line.worldTime, text: line.text, narrated: line.narrated === true });
    }
    for (const e of p.encounters) {
      // Incomplete legacy records are not turned into invented paired trajectories.
      if (!isRecordedEncounter(e) || ![e.trace.predatorId, e.trace.preyId].includes(id)) continue;
      if (e.trace.startWorldTime < 0 || e.trace.startWorldTime + e.trace.samples.at(-1)!.seconds > p.asOfWorldTime + 1)
        throw new Error('Encounter exceeds its history checkpoint.');
      if (e.eventId === options.selectedEventId) selected = e;
      recent.push(e); if (recent.length > 50) recent.shift();
    }
    options.progress?.(++pages, moments.length);
    if (p.nextCursor === null) break;
    if (cursors.has(p.nextCursor)) throw new Error('Repeating life-history cursor.');
    cursors.add(p.nextCursor); url = `${path}?cursor=${encodeURIComponent(p.nextCursor)}`;
  }
  options.signal.throwIfAborted();
  if (options.selectedEventId && !selected) throw new Error('Selected event has no playable paired recording in this checkpoint.');
  if (selected && !recent.some(e => e.eventId === selected!.eventId)) recent.unshift(selected);
  return { ...biography!, moments, encounters: recent };
}
