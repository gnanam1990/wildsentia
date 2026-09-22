import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';

export type EventType =
  | 'agent_spawned' | 'goal_selected' | 'fed' | 'drank' | 'rested'
  | 'moved' | 'starved' | 'died' | 'immigration' | 'season_changed';

export type Confidence = 'authoritative' | 'high' | 'medium' | 'low';

export interface WorldEvent {
  id: string;
  type: EventType;
  worldTime: WorldTime;
  simVersion: string;
  patchId: PatchId;
  actors: string[];
  goal?: string;
  conditions: Record<string, number | string>;
  outcome: 'success' | 'failure' | 'abandoned' | 'interrupted';
  effects: Record<string, number>;
  causalParents: string[];
  confidence: Confidence;
}
