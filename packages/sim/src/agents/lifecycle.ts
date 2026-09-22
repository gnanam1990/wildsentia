import type { Agent, LifeStage, SpeciesConfig } from '@vana/shared';

/** Which stage an animal of this age is in. Stages are ordered and start at day zero. */
export function stageFor(ageDays: number, config: SpeciesConfig): LifeStage {
  let current: LifeStage = config.lifecycle.stages[0]!.name;
  for (const stage of config.lifecycle.stages) {
    if (ageDays >= stage.startDays) current = stage.name;
    else break;
  }
  return current;
}

export function stageConfig(
  stage: LifeStage,
  config: SpeciesConfig,
): SpeciesConfig['lifecycle']['stages'][number] {
  const found = config.lifecycle.stages.find((s) => s.name === stage);
  if (found === undefined) throw new Error(`${config.id} has no ${stage} stage`);
  return found;
}

/** Target mass for an animal at its current stage. Growth moves it toward this. */
export function targetMass(agent: Agent, config: SpeciesConfig): number {
  return config.body.adultMassKg * stageConfig(agent.lifeStage, config).sizeFactor;
}

export function isDependent(agent: Agent, config: SpeciesConfig): boolean {
  return agent.dependentOn !== null && stageConfig(agent.lifeStage, config).dependent;
}

export function mortalityFor(agent: Agent, config: SpeciesConfig): number {
  return stageConfig(agent.lifeStage, config).mortalityPerDay;
}

export function canBreed(agent: Agent, config: SpeciesConfig): boolean {
  return agent.alive
    && agent.ageDays >= config.lifecycle.sexualMaturityDays
    && (agent.lifeStage === 'adult' || agent.lifeStage === 'elder');
}
