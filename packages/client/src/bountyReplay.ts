import type { Life, LifeMoment, LifeTrackPoint } from './replay.js';

/**
 * Congo spec §5 Records and replay: a decided bounty replayed in the forest viewer from its record,
 * the target's sampled path over the bounty (its track log, thinned) and the events that decided it.
 * Served only once a bounty is settled, so nothing here reveals a bounty while it lasts.
 */
export interface BountyRecordView {
  bountyId: string; outcome: string; targetAnimalId: string; targetSpeciesId: string; winnerAnimalId: string | null;
  decidedWorldTime: number | null;
  record: { events: Array<{ id?: string; type?: string; worldTime?: number; outcome?: string; actors?: string[]; position?: { x: number; z: number; heading?: number } }>;
    track: Array<{ x: number; z: number; state: string; worldTime: number }> };
}

const NAMES: Record<string, string> = { african_leopard: 'an African leopard', blue_duiker: 'a blue duiker', water_chevrotain: 'a water chevrotain' };
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isBountyRecord(v: unknown): v is BountyRecordView {
  if (!obj(v) || typeof v.bountyId !== 'string' || typeof v.outcome !== 'string' || typeof v.targetAnimalId !== 'string' || !v.targetAnimalId
    || typeof v.targetSpeciesId !== 'string' || !v.targetSpeciesId || !(v.winnerAnimalId === null || typeof v.winnerAnimalId === 'string')
    || !(v.decidedWorldTime === null || finite(v.decidedWorldTime)) || !obj(v.record)) return false;
  const { events, track } = v.record;
  return Array.isArray(events) && events.every(obj) && Array.isArray(track) && track.length <= 2_000
    && track.every((s) => obj(s) && finite(s.x) && finite(s.z) && finite(s.worldTime) && typeof s.state === 'string');
}

/** The record as a life the replay player already plays: whole, increasing world times; its end. */
export function bountyLife(r: BountyRecordView, patchOf: (x: number, z: number) => number | null): Life {
  const track: LifeTrackPoint[] = [];
  for (const s of r.record.track) {
    const worldTime = Math.floor(s.worldTime), patchId = patchOf(s.x, s.z);
    if (patchId === null || (track.length && worldTime <= track.at(-1)!.worldTime)) continue;
    const prev = track.at(-1)?.position;
    const heading = prev && (s.x !== prev.x || s.z !== prev.z) ? Math.atan2(s.x - prev.x, s.z - prev.z) : prev?.heading ?? 0;
    track.push({ worldTime, patchId, state: s.state, goal: 'bounty', drives: { hunger: 0, thirst: 0, fatigue: 0, fear: 0 },
      position: { x: s.x, z: s.z, heading } });
  }
  const end = Math.floor(r.decidedWorldTime ?? track.at(-1)?.worldTime ?? 0);
  const caught = r.outcome === 'predator';
  // The path runs on to the decision, so its last moment plays; a kill ends where it happened.
  const kill = caught ? r.record.events.find((e) => e.type === 'hunt' && e.outcome === 'success' && e.actors?.includes(r.targetAnimalId)) : undefined;
  const last = track.at(-1);
  if (last && end > last.worldTime) {
    const at = kill?.position && finite(kill.position.x) && finite(kill.position.z) ? kill.position : last.position!;
    const patchId = patchOf(at.x, at.z) ?? last.patchId;
    const heading = at.x !== last.position!.x || at.z !== last.position!.z ? Math.atan2(at.x - last.position!.x, at.z - last.position!.z) : last.position!.heading;
    track.push({ ...last, worldTime: end, patchId, position: { x: at.x, z: at.z, heading } });
  }
  const moments: LifeMoment[] = [];
  for (const e of r.record.events) {
    if (!finite(e.worldTime) || !e.actors?.includes(r.targetAnimalId)) continue;
    const eventId = typeof e.id === 'string' && e.id ? e.id : `bounty:${r.bountyId}:${moments.length}`;
    if (e.type === 'hunt' && e.outcome === 'success') {
      const hunter = e.actors.find((a) => a !== r.targetAnimalId) ?? '';
      const species = Object.keys(NAMES).find((k) => hunter.startsWith(`${k}_`));
      moments.push({ eventId, worldTime: Math.round(e.worldTime), text: `Caught by ${species ? NAMES[species] : 'a hunter'}: the bounty went to the hunter` });
    } else if (e.type === 'died' || e.type === 'death') moments.push({ eventId, worldTime: Math.round(e.worldTime), text: 'Died' });
  }
  if (!caught && r.outcome === 'survival')
    moments.push({ eventId: `bounty:${r.bountyId}:end`, worldTime: end, text: 'Alive at the deadline: the bounty went to its owner' });
  return { id: r.targetAnimalId, speciesId: r.targetSpeciesId, alive: !caught, bornAt: track[0]?.worldTime ?? end,
    departedAt: caught ? end : null, track, moments };
}

/** Loads a settled bounty's record and builds its life; throws a reader-facing message otherwise. */
export async function loadBountyLife(bountyId: string, signal: AbortSignal, patchOf: (x: number, z: number) => number | null): Promise<Life> {
  const response = await fetch(`/api/congo/bounties/${encodeURIComponent(bountyId)}/record`, { signal });
  if (!response.ok) throw new Error('This bounty has no replay yet: it is shown once it is settled.');
  const body: unknown = await response.json();
  if (!isBountyRecord(body)) throw new Error('This bounty\'s record could not be read.');
  const life = bountyLife(body, patchOf);
  if (life.track.length === 0) throw new Error('This bounty\'s record has no recorded path to replay.');
  return life;
}
