import type { Agent, Patch, RngState, WorldTime } from '@vana/shared';
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
  world.ledger.imported = snapshot.ledger.imported;
  world.ledger.exported = snapshot.ledger.exported;
  world.__importState(snapshot.worldTime, snapshot.agentSeq, snapshot.rngState);

  return world;
}
