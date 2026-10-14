import { parentPort, workerData } from "node:worker_threads";
import {
  createRng,
  landWalkable,
  patchCentre,
  waterAccessPosition,
  NUTRIENT_PER_KG_BIOMASS,
  arenaCommand,
  type ArenaCommand,
  type ArenaFrame,
  type LeagueRequest,
  type LeaguePlayer,
  type LeagueWorld,
  type LabRequest,
  type LabSample,
  type LabResult,
} from "@vana/shared";
import {
  createWorld,
  restoreSnapshot,
  totalNutrients,
  SIM_VERSION,
  type Snapshot,
  type World,
} from "@vana/sim";
import { LiveLayer } from "../live/liveLayer.js";
import { worldPort } from "../live/worldPort.js";

export interface LeagueWorkerInput {
  kind: "league";
  request: LeagueRequest;
  player: LeaguePlayer;
  speciesDir: string;
  /** The server's world: a match is played among its own animals (island when absent). */
  world?: LeagueWorld;
}
export interface LabWorkerInput {
  kind: "lab";
  request: LabRequest;
  snapshot: Snapshot;
  speciesDir: string;
}
export type WorkerInput = LeagueWorkerInput | LabWorkerInput;
const send = (value: unknown) => parentPort?.postMessage(value);

export function experimentSnapshot(
  source: Snapshot,
  scenario: LabRequest["scenario"],
): { snapshot: Snapshot; removed: number } {
  const snapshot = structuredClone(source);
  let removed = 0;
  if (scenario === "fewer_predators") {
    // The island's predators, and the Congo forest's.
    const names = new Set(["tiger", "leopard", "dhole", "jackal", "african_leopard", "african_golden_cat"]);
    const bySpecies = new Map<string, number>();
    const gone = new Set<string>();
    for (const a of snapshot.agents)
      if (names.has(a.speciesId)) {
        const n = bySpecies.get(a.speciesId) ?? 0;
        bySpecies.set(a.speciesId, n + 1);
        if (n % 2 === 1) {
          gone.add(a.id);
          a.alive = false;
          a.state = "emigrated";
          a.departedAt = snapshot.worldTime;
          snapshot.ledger.exported +=
            (a.massKg + (a.packFood?.kg ?? 0)) * NUTRIENT_PER_KG_BIOMASS;
          snapshot.deceased.push(a);
          removed++;
        }
      }
    snapshot.agents = snapshot.agents.filter((a) => !gone.has(a.id));
    for (const [, group] of snapshot.groups)
      group.memberIds = group.memberIds.filter((id) => !gone.has(id));
  }
  return { snapshot, removed };
}
export function labSample(
  w: World,
  day: number,
  births: number,
  deaths: number,
): LabSample {
  const population: Record<string, number> = {};
  for (const a of w.agents)
    if (a.alive) population[a.speciesId] = (population[a.speciesId] ?? 0) + 1;
  return {
    day,
    population,
    waterL: w.patches.reduce((n, p) => n + p.waterVolume, 0),
    vegetationKg: w.patches.reduce(
      (n, p) => n + p.plant.grass + p.plant.browse,
      0,
    ),
    nutrients: totalNutrients(
      w.patches,
      w.agents,
      w.ledger,
      w.carcasses,
      w.microEcology,
      w.community,
    ),
    births,
    deaths,
    peopleAlive: w.community?.people.filter((p) => p.alive).length ?? 0,
  };
}
async function lab(input: LabWorkerInput) {
  const altered = experimentSnapshot(input.snapshot, input.request.scenario);
  const options = {
    seed: input.snapshot.seed,
    speciesDir: input.speciesDir,
    initialAgents: {},
    minPopulation: {},
    retainEvents: 500 as const,
    terrainProfile: input.snapshot.terrainProfile ?? "mainland",
    communityProfile: input.snapshot.community?.profile ?? ("none" as const),
  };
  const baseline = restoreSnapshot(structuredClone(input.snapshot), options);
  const experiment = restoreSnapshot(altered.snapshot, {
    ...options,
    ...(input.request.scenario === "no_rain" ? { rainfallScale: 0 } : {}),
  });
  for (const w of [baseline, experiment])
    for (const a of w.agents) if (a.controller) w.release(a.id);
  const samples: [LabSample[], LabSample[]] = [[], []];
  let completed = 0;
  for (const [i, w] of [baseline, experiment].entries()) {
    let births = 0,
      deaths = 0;
    const initial = new Set(w.agents.map((a) => a.id));
    const deathsAtStart = w.deceased.filter(
      (a) => a.state !== "emigrated",
    ).length;
    samples[i]!.push(labSample(w, 0, 0, 0));
    for (let day = 1; day <= input.request.days; day++) {
      for (let hour = 0; hour < 24; hour++) w.step(1);
      births = [...w.agents, ...w.deceased].filter(
        (a) => !initial.has(a.id) && a.motherId !== null,
      ).length;
      deaths =
        w.deceased.filter((a) => a.state !== "emigrated").length -
        deathsAtStart;
      samples[i]!.push(labSample(w, day, births, deaths));
      completed++;
      send({
        type: "lab_progress",
        percent: (completed / (2 * input.request.days)) * 100,
        baseline: samples[0],
        experiment: samples[1],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const result: LabResult = {
    scenario: input.request.scenario,
    days: input.request.days,
    completedDays: input.request.days,
    checkpointWorldTime: input.snapshot.worldTime,
    simVersion: SIM_VERSION,
    baseline: samples[0],
    experiment: samples[1],
    removedAnimals: altered.removed,
    assumptions: [
      "Both forks start from the same saved checkpoint and RNG state.",
      "Player-controlled animals return to autonomous behavior in both forks.",
      "The copied experiments use a closed population policy without mainland edge exchange.",
      "This is a simulation experiment, not a forecast of a real forest.",
      input.request.scenario === "no_rain"
        ? "Rainfall is zero in the experiment; groundwater and evaporation keep their existing rules."
        : `${altered.removed} predators leave the copied experiment; their biomass is recorded as nutrient export.`,
    ],
  };
  send({ type: "lab_done", result });
}
export function applyArenaCommand(
  live: LiveLayer,
  id: string,
  c: ArenaCommand,
): string | null {
  if (c.action === "go_to") return live.goTo(id, { x: c.x, z: c.z }, c.gait);
  if (c.action === "hunt") return live.hunt(id, c.preyId);
  return c.action === "stop" ? live.stop(id) : live.act(id, c.action);
}
const ISLAND_LEAGUE_ANIMALS = { tiger: 6, leopard: 6, chital: 14, hare: 14, boar: 8, sambar: 8, dhole: 6, langur: 6 };
const CONGO_LEAGUE_ANIMALS = {
  african_leopard: 6, african_golden_cat: 4, blue_duiker: 14, bay_duiker: 6, peters_duiker: 6,
  red_river_hog: 8, water_chevrotain: 6, sitatunga: 4, forest_buffalo: 4,
};
async function league(input: LeagueWorkerInput) {
  const { request, player } = input;
  const rng = createRng(request.seed, "league-live");
  Math.random = () => rng.next();
  const w = createWorld({
    seed: request.seed,
    speciesDir: input.speciesDir,
    ...(input.world === "congo"
      ? { terrainProfile: "congo_v1" as const, initialAgents: CONGO_LEAGUE_ANIMALS }
      : { terrainProfile: "island_v2" as const, initialAgents: ISLAND_LEAGUE_ANIMALS }),
    minPopulation: {},
    retainEvents: 500,
  });
  const candidate = w.possessionCandidates(request.species, 20)[0];
  if (!candidate) throw new Error("arena_animal_unavailable");
  // In the Congo forest, every patch holds water; a match starts in flooded forest, by a river.
  const home = w.patches
    .filter((p) => landWalkable(p) && p.waterVolume > 20 && (input.world !== "congo" || p.habitat === "flooded_forest"))
    .sort((a, b) => a.id - b.id)[0];
  if (!home) throw new Error("arena_water_unavailable");
  // A Congo patch's water is at its river edge, often far from the patch centre: start beside it,
  // as an island match starts beside its pool.
  const at = input.world === "congo" ? waterAccessPosition(w.grid, home.id, w.patches) : patchCentre(w.grid, home.id);
  for (const a of w.agents) {
    const x = at.x + rng.range(-90, 90),
      z = at.z + rng.range(-90, 90);
    w.placeWild(a.id, { x, z, heading: 0 });
  }
  w.placeWild(candidate.id, { x: at.x, z: at.z, heading: 0 });
  candidate.drives.thirst = 0.65;
  candidate.drives.hunger = 0.4;
  candidate.drives.fear = 0;
  candidate.drives.fatigue = 0.1;
  let second = 0,
    kills = 0,
    drank = false,
    completedAt: number | null = null,
    pending = false,
    decisions = 0,
    providerError = false;
  let usedTurn = -1,
    offeredTurn = -1,
    modelTurn = -1,
    modelRequests = 0;
  const turn = () =>
    Math.min(
      7,
      Math.floor((Math.max(0, second - 1) * 8) / request.durationSeconds),
    );
  const port = worldPort(
    () => w,
    () => "isolated-league",
  );
  const act = port.act;
  // Action time can flush on a new command as well as on a tick. Count this animal's
  // actual water withdrawal in either path, never the wild cohort's consumption.
  port.act = (animalId, action, seconds) => {
    const before = w.waterBudget.animalConsumptionL;
    const result = act(animalId, action, seconds);
    if (
      animalId === candidate.id &&
      action === "drink" &&
      w.waterBudget.animalConsumptionL > before
    )
      drank = true;
    return result;
  };
  const live = new LiveLayer(port, null, () => second * 1000);
  const id = "league-player";
  const held = live.possess(
    id,
    player.label,
    { animalId: candidate.id },
    false,
  );
  if (!held.ok) throw new Error("arena_possession_failed");
  live.onHunt = (h) => {
    if (h.predatorAgentId === id && h.killed) kills++;
  };
  let notice =
    "Match started. Both players have identical starting conditions.";
  const frame = (): ArenaFrame => {
    const avatar = live.avatars.get(id),
      animal = w.animal(candidate.id);
    const alive = !!animal?.alive && !!avatar;
    const x = avatar?.x ?? candidate.position?.x ?? at.x,
      z = avatar?.z ?? candidate.position?.z ?? at.z;
    const nearby = port
      .nearby(x, z, 320, 24)
      .filter((a) => a.id !== candidate.id)
      .map((a) => ({
        id: a.id,
        speciesId: a.speciesId,
        x: live.positionOf(a.id)?.x ?? a.position.x,
        z: live.positionOf(a.id)?.z ?? a.position.z,
        state: live.wild.get(a.id)?.mode ?? a.state,
        heading: live.positionOf(a.id)?.heading ?? a.position.heading,
        lifeStage: a.lifeStage,
        drives: { ...a.drives },
      }));
    return {
      second,
      animal: animal
        ? {
            id: animal.id,
            speciesId: animal.speciesId,
            x,
            z,
            state: avatar?.action ?? animal.state,
            heading: avatar?.heading ?? animal.position?.heading ?? 0,
            lifeStage: animal.lifeStage,
            drives: { ...animal.drives },
          }
        : null,
      nearby,
      huntablePrey: nearby
        .filter((a) => {
          const motion = port.species(candidate.speciesId);
          return (
            motion?.preferredPrey.includes(a.speciesId) &&
            Math.hypot(a.x - x, a.z - z) <= motion.sightRangeM
          );
        })
        .map((a) => a.id),
      water: port
        .waterPoints(x, z, 500)
        .slice(0, 12)
        .map((p) => ({ x: p.x, z: p.z })),
      drives: animal ? { ...animal.drives } : null,
      stamina: avatar?.stamina ?? 0,
      kills,
      drank,
      alive,
      completedAt,
      turn: turn() + 1,
      commandReady: alive && completedAt === null && usedTurn !== turn(),
      nextTurnIn: Math.max(
        0,
        Math.ceil(((turn() + 1) * request.durationSeconds) / 8 - second),
      ),
      points:
        request.mission === "survive"
          ? Math.round((second / request.durationSeconds) * 100) * Number(alive)
          : completedAt !== null
            ? 100 + request.durationSeconds - completedAt
            : Math.min(99, kills * 50 + Number(drank) * 50),
      notice,
    };
  };
  const command = (raw: unknown) => {
    const c = arenaCommand(raw);
    if (!c || !live.avatars.has(id) || completedAt !== null) return;
    if (usedTurn === turn()) {
      notice = "Wait for your next command turn.";
      return;
    }
    usedTurn = turn();
    decisions++;
    const error = applyArenaCommand(live, id, c);
    notice = error
      ? error.replaceAll("_", " ")
      : `${c.action.replaceAll("_", " ")} accepted`;
  };
  const onMessage = (m: {
    type?: string;
    command?: unknown;
    error?: string;
    turn?: number;
  }) => {
    if (m.type === "human_command" && player.source === "human")
      command(m.command);
    if (m.type === "model_command" && pending) {
      pending = false;
      if (m.error) {
        providerError = true;
        notice = "Model unavailable; this entry is disqualified.";
      } else if (m.turn === modelTurn && modelTurn === turn())
        command(m.command);
      else notice = "The model missed its command turn.";
    }
  };
  parentPort?.on("message", onMessage);
  const localDecision = (f: ArenaFrame) => {
    if (!f.animal || !f.drives) return;
    const water = f.water.toSorted(
      (a, b) =>
        Math.hypot(a.x - f.animal!.x, a.z - f.animal!.z) -
        Math.hypot(b.x - f.animal!.x, b.z - f.animal!.z),
    )[0];
    if (
      water &&
      ((request.mission === "water" && !drank) || f.drives.thirst > 0.5)
    ) {
      command(
        Math.hypot(water.x - f.animal.x, water.z - f.animal.z) <= 1.5
          ? { action: "drink" }
          : {
              action: "go_to",
              x: water.x,
              z: water.z,
              gait: player.id === "local:careful" ? "walk" : "trot",
            },
      );
      return;
    }
    const prey = f.nearby.find((a) =>
      port.species(candidate.speciesId)?.preferredPrey.includes(a.speciesId),
    );
    if (prey && request.mission === "hunt") {
      if (!live.avatars.get(id)?.hunt)
        command({ action: "hunt", preyId: prey.id });
      return;
    }
    const threat = f.nearby.find((a) =>
      port.species(a.speciesId)?.preferredPrey.includes(candidate.speciesId),
    );
    if (threat) {
      const dx = f.animal.x - threat.x,
        dz = f.animal.z - threat.z,
        norm = Math.max(1, Math.hypot(dx, dz));
      command({
        action: "go_to",
        x: f.animal.x + (dx / norm) * 50,
        z: f.animal.z + (dz / norm) * 50,
        gait: "run",
      });
      return;
    }
    command({
      action:
        f.drives.fatigue > 0.5
          ? "rest"
          : port.species(candidate.speciesId)?.eatsPlants
            ? "graze"
            : "rest",
    });
  };
  try {
    send({ type: "league_frame", frame: frame(), decisions, providerError });
    for (second = 1; second <= request.durationSeconds; second++) {
      const start = Date.now();
      live.presence(id);
      for (let i = 0; i < 10; i++) live.tick(0.1);
      w.step(1 / 3600);
      const f = frame();
      if (
        completedAt === null &&
        f.alive &&
        ((request.mission === "water" && drank) ||
          (request.mission === "hunt" && kills > 0) ||
          (request.mission === "survive" && second === request.durationSeconds))
      )
        completedAt = second;
      if (player.source === "local" && offeredTurn !== turn()) {
        offeredTurn = turn();
        localDecision(frame());
      }
      if (
        player.source === "openrouter" &&
        !pending &&
        !providerError &&
        modelRequests < 8 &&
        offeredTurn !== turn()
      ) {
        offeredTurn = turn();
        modelTurn = turn();
        modelRequests++;
        pending = true;
        send({
          type: "model_request",
          observation: {
            ...frame(),
            nearby: frame().nearby.slice(0, 10),
            huntable: port.species(candidate.speciesId)?.preferredPrey ?? [],
          },
          decisions: modelRequests,
          turn: modelTurn,
        });
      }
      send({ type: "league_frame", frame: frame(), decisions, providerError });
      if (!f.alive || completedAt !== null || providerError) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 1000 - (Date.now() - start))),
      );
    }
    if (second > request.durationSeconds) second = request.durationSeconds;
    send({ type: "league_done", frame: frame(), decisions, providerError });
  } finally {
    parentPort?.off("message", onMessage);
  }
}
if (parentPort) {
  const input = workerData as WorkerInput;
  void (input.kind === "lab" ? lab(input) : league(input)).catch((error) => {
    console.error("[experiences worker]", error);
    send({ type: "failed", error: "simulation_failed" });
  });
}
