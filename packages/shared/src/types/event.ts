import type { PatchId } from './patch.js';
import type { WorldTime } from '../time.js';
import type { EncounterTrace } from '../encounter.js';
import type { MovementTrace } from '../movement.js';
import type { WorldPosition } from '../spatial.js';

export type EventType =
  | 'agent_spawned' | 'goal_selected' | 'fed' | 'drank' | 'rested'
  | 'moved' | 'tree_climbed' | 'starved' | 'died' | 'immigration' | 'emigration' | 'skill_taught' | 'season_changed'
  | 'maintenance'
  | 'community_founded' | 'human_task_started' | 'human_task_finished' | 'human_task_interrupted'
  | 'human_died' | 'building_stage' | 'building_repaired' | 'building_shelter_changed'
  | 'building_storm' | 'building_flooded' | 'building_collapsed' | 'building_rebuilt'
  | 'human_cooperated' | 'human_skill_learned' | 'human_resource_collected' | 'human_hunt'
  | 'human_conceived' | 'human_born' | 'human_pregnancy_lost' | 'human_cared'
  | 'hunt' | 'scavenged' | 'fled' | 'carcass_created' | 'carcass_stage'
  | 'nutrients_returned'
  | 'disease_contracted' | 'disease_symptomatic' | 'disease_recovered' | 'disease_fatal'
  | 'wounded' | 'wound_infected' | 'wound_healed' | 'wound_infection_fatal'
  | 'fish_spawned' | 'fish_hatched' | 'fish_recruited' | 'fish_cohort_lost'
  | 'flowering_started' | 'flower_visitation_settled' | 'seeds_matured' | 'plants_recruited' | 'seed_bank_lost'
  | 'pack_food_collected' | 'pack_food_delivered' | 'pack_food_digested'
  | 'born' | 'courtship' | 'life_stage' | 'dispersed' | 'parent_lost' | 'provisioned' | 'nursing_site_established';

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
  encounter?: EncounterTrace;
  movement?: MovementTrace;
  /** Location at the event instant, not the actor's later position. Absent on legacy events. */
  position?: WorldPosition;
}
