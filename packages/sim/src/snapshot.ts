import type { Agent, Carcass, Patch, RngState, WorldTime } from '@vana/shared';
import type { NutrientLedger } from './fields/nutrients.js';
import { SIM_VERSION, World, type WorldOptions } from './world.js';

export interface Snapshot {
  simVersion: string;
  worldTime: WorldTime;
  seed: number;
  patches: Patch[];
  agents: Agent[];
  ledger: NutrientLedger;
  agentSeq: number;
  rngState: RngState;
  carcasses: Carcass[];
  carcassSeq: number;
  deceased: Agent[];
  groupSeq: number;
  groups: Array<[string, { speciesId: string; memberIds: string[] }]>;
  pedigree: Array<[string, { mother: string | null; father: string | null }]>;
}

export function takeSnapshot(world: World): Snapshot {
  const state = world.__exportState();
  return {
    simVersion: SIM_VERSION,
    worldTime: world.now(),
    seed: state.seed,
    patches: structuredClone(world.patches),
    agents: structuredClone(world.agents),
    ledger: { ...world.ledger },
    agentSeq: state.agentSeq,
    rngState: state.rngState,
    carcasses: structuredClone(world.carcasses),
    carcassSeq: state.carcassSeq,
    deceased: structuredClone(world.deceased),
    groupSeq: state.groupSeq,
    groups: structuredClone(state.groups),
    pedigree: structuredClone(state.pedigree),
  };
}

export function restoreSnapshot(snapshot: Snapshot, options: WorldOptions): World {
  if (snapshot.simVersion !== SIM_VERSION) {
    throw new Error(
      `snapshot sim version ${snapshot.simVersion} does not match runtime ${SIM_VERSION}`,
    );
  }

  // Build an empty world, then overwrite its state from the snapshot.
  const world = new World({ ...options, initialAgents: {}, minPopulation: {} });

  world.patches.length = 0;
  world.patches.push(...structuredClone(snapshot.patches));
  world.agents.length = 0;
  world.agents.push(...structuredClone(snapshot.agents));
  world.carcasses.length = 0;
  world.carcasses.push(...structuredClone(snapshot.carcasses ?? []));
  world.deceased.length = 0;
  world.deceased.push(...structuredClone(snapshot.deceased ?? []));
  world.ledger.imported = snapshot.ledger.imported;
  world.ledger.exported = snapshot.ledger.exported;
  world.__importState(
    snapshot.worldTime, snapshot.agentSeq, snapshot.rngState,
    snapshot.carcassSeq ?? 0, snapshot.groupSeq ?? 0,
    snapshot.groups ?? [], snapshot.pedigree ?? [],
  );

  return world;
}
