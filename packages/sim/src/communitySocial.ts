import { patchAtPosition, type CommunityState, type HumanAction, type HumanSkill, type WorldPosition } from '@vana/shared';
import type { EventLog } from './events/log.js';

export interface HumanWorkWindow {
  personId: string;
  action: HumanAction;
  start: number;
  end: number;
  position: WorldPosition;
  taskEventId: string;
  /** Snapshot before this window's practice or learning increments. */
  skill: HumanSkill;
  skillValue: number;
}
export function workSkill(action: HumanAction): HumanSkill | null {
  if (action.startsWith('gather_')) return 'gathering';
  if (action === 'build' || action === 'repair') return 'building';
  if (action === 'fish') return 'fishing';
  if (action === 'hunt') return 'hunting';
  return null;
}

/** Applies only paid, overlapping work within conversation distance. No remote friendship,
 * idle teaching, extra labour, material grants or model-written relationships. */
export function learnFromSharedWork(state: CommunityState, windows: readonly HumanWorkWindow[], log: EventLog): void {
  if (state.version < 3) return;
  const people = new Map(state.people.map(p => [p.id, p]));
  // Code-point order (sim_0.38.0): localeCompare followed the host's locale data.
  const ordered = [...windows].sort((a, b) => a.start - b.start || (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const a = ordered[i]!, b = ordered[j]!;
    if (a.personId === b.personId || a.action !== b.action || a.skill !== b.skill || workSkill(a.action) !== a.skill) continue;
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
    if (end <= start || Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) > 3) continue;
    const pa = people.get(a.personId), pb = people.get(b.personId);
    const workPatch = state.version >= 5 ? patchAtPosition(a.position) : pa?.patchId;
    if (!pa || !pb || workPatch !== (state.version >= 5 ? patchAtPosition(b.position) : pb.patchId)) continue;
    if ((pa.diedAt !== null && pa.diedAt <= start) || (pb.diedAt !== null && pb.diedAt <= start)) continue;
    const seconds = Math.min(end, pa.diedAt ?? end, pb.diedAt ?? end) - start;
    if (seconds <= 0) continue;
    const interactionEnd = start + seconds;
    const members = [a.personId, b.personId].sort() as [string, string];
    const relationships = state.relationships!;
    let relationship = relationships.find(r => r.members[0] === members[0] && r.members[1] === members[1]);
    if (!relationship) {
      relationship = { members, sharedWorkSeconds: 0, lastInteractionAt: interactionEnd, trust: 0, reportedHours: 0, lessons: [] };
      relationships.push(relationship); relationships.sort((x, y) => { const p = x.members.join(':'), q = y.members.join(':'); return p < q ? -1 : p > q ? 1 : 0; });
    }
    relationship.sharedWorkSeconds += seconds; relationship.lastInteractionAt = Math.max(relationship.lastInteractionAt, interactionEnd);
    // This is an explicit cooperation score, not a claim to infer human feelings.
    relationship.trust = Math.min(1, relationship.sharedWorkSeconds / (40 * 3600));
    const parents = [...new Set([a.taskEventId, b.taskEventId])];
    const append = (type: 'human_cooperated' | 'human_skill_learned', actors: string[], conditions: Record<string, string | number>, effects: Record<string, number>) => {
      log.append({ type, worldTime: Math.floor(interactionEnd), simVersion: '', patchId: workPatch!,
        position: { ...a.position }, actors: [...actors, state.id], goal: a.action, conditions,
        effects, outcome: 'success', causalParents: parents, confidence: 'authoritative' });
    };
    const hours = Math.floor(relationship.sharedWorkSeconds / 3600);
    if (hours > relationship.reportedHours) {
      relationship.reportedHours = hours;
      append('human_cooperated', members, { activity: a.action, evidence: 'overlapping_local_work' },
        { sharedWorkSeconds: relationship.sharedWorkSeconds, trust: relationship.trust });
    }
    const teacher = a.skillValue >= b.skillValue ? a : b, learner = teacher === a ? b : a;
    if (teacher.skillValue - learner.skillValue < .05) continue;
    const pupil = people.get(learner.personId)!;
    const current = pupil.skills[learner.skill] ?? 0;
    // At most 1.5% of the observed skill gap per shared-work hour. Multiple teachers cannot
    // push a learner past the actual demonstrated skill; ordinary work time is not duplicated.
    const gain = Math.min(Math.max(0, teacher.skillValue - current), (teacher.skillValue - learner.skillValue) * .015 * seconds / 3600);
    if (gain <= 0) continue;
    pupil.skills[learner.skill] = current + gain;
    let lesson = relationship.lessons.find(l => l.learnerId === learner.personId && l.teacherId === teacher.personId && l.skill === learner.skill);
    if (!lesson) {
      lesson = { learnerId: learner.personId, teacherId: teacher.personId, skill: learner.skill, observedSeconds: 0, gain: 0, reportedGain: 0 };
      relationship.lessons.push(lesson);
    }
    lesson.observedSeconds += seconds; lesson.gain += gain;
    if (lesson.gain - lesson.reportedGain >= .005) {
      const gained = lesson.gain - lesson.reportedGain; lesson.reportedGain = lesson.gain;
      append('human_skill_learned', [learner.personId, teacher.personId],
        { skill: learner.skill, method: 'observed_shared_work' },
        { skillGain: gained, skill: pupil.skills[learner.skill]!, observedSeconds: lesson.observedSeconds });
    }
  }
}
