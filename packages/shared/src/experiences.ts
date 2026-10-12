/** Contracts shared by the forest experiences API and its browser. */
export type LeagueMission = "water" | "hunt" | "survive";
export type LabScenario = "no_rain" | "fewer_predators";
export type ExperienceStatus =
  "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface LeaguePlayer {
  id: string;
  label: string;
  source: "local" | "human" | "openrouter";
}
export interface LeagueRequest {
  mission: LeagueMission;
  species: "tiger" | "leopard" | "chital" | "hare";
  durationSeconds: 180 | 300;
  players: string[];
  seed: number;
}
export interface LabRequest {
  scenario: LabScenario;
  days: 3 | 7 | 30;
}
export interface ArenaAnimal {
  id: string;
  speciesId: string;
  x: number;
  z: number;
  state: string;
  heading?: number;
  lifeStage?: string;
  drives?: { hunger: number; thirst: number; fatigue: number; fear: number };
}
export interface ArenaFrame {
  second: number;
  animal: ArenaAnimal | null;
  nearby: ArenaAnimal[];
  huntablePrey: string[];
  water: Array<{ x: number; z: number }>;
  drives: {
    hunger: number;
    thirst: number;
    fatigue: number;
    fear: number;
  } | null;
  stamina: number;
  kills: number;
  drank: boolean;
  alive: boolean;
  points: number;
  completedAt: number | null;
  notice: string;
  turn: number;
  commandReady: boolean;
  nextTurnIn: number;
}
export interface LeagueStanding {
  player: LeaguePlayer;
  frame: ArenaFrame;
  frames: ArenaFrame[];
  status: "playing" | "finished" | "provider_error";
  decisions: number;
}
export interface LabSample {
  day: number;
  population: Record<string, number>;
  waterL: number;
  vegetationKg: number;
  nutrients: number;
  births: number;
  deaths: number;
  peopleAlive: number;
}
export interface LabResult {
  scenario: LabScenario;
  days: number;
  completedDays: number;
  checkpointWorldTime: number;
  simVersion: string;
  baseline: LabSample[];
  experiment: LabSample[];
  removedAnimals: number;
  assumptions: string[];
}
export interface ExperienceJob {
  id: string;
  kind: "league" | "lab";
  status: ExperienceStatus;
  createdAt: string;
  request: LeagueRequest | LabRequest;
  progress: {
    percent: number;
    standings?: LeagueStanding[];
    baseline?: LabSample[];
    experiment?: LabSample[];
  };
  result: { standings: LeagueStanding[]; winners: string[] } | LabResult | null;
  error: string | null;
}
export interface ForestMoment {
  id: string;
  type: string;
  actorId: string | null;
  worldTime: number;
  title: string;
  detail: string;
  replay: "hunt" | "climb" | null;
  position: { x: number; z: number } | null;
}
export interface SafariAnswer {
  answer: string;
  animalId: string | null;
  source: "checkpoint";
  worldTime: number;
  eventIds: string[];
}
export interface FollowedLife {
  animalId: string;
  nickname: string;
  alive: boolean | null;
  speciesId: string | null;
  motherId: string | null;
  fatherId: string | null;
  offspringIds: string[];
  moments: ForestMoment[];
  unread: number;
}
export const EXPERIENCE_LOCAL_PLAYERS: LeaguePlayer[] = [
  { id: "local:forager", label: "Forager", source: "local" },
  { id: "local:careful", label: "Careful", source: "local" },
  { id: "human", label: "You", source: "human" },
];
export type ArenaCommand =
  | { action: "go_to"; x: number; z: number; gait: "walk" | "trot" | "run" }
  | { action: "hunt"; preyId: string }
  | { action: "drink" | "graze" | "rest" | "feed" | "stop" };
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function leagueRequest(
  x: unknown,
  allowed: readonly string[],
): LeagueRequest | null {
  if (
    !record(x) ||
    typeof x.mission !== "string" ||
    typeof x.species !== "string" ||
    !["water", "hunt", "survive"].includes(String(x.mission)) ||
    !["tiger", "leopard", "chital", "hare"].includes(String(x.species)) ||
    (x.mission === "hunt" &&
      !["tiger", "leopard"].includes(String(x.species))) ||
    ![180, 300].includes(Number(x.durationSeconds)) ||
    typeof x.durationSeconds !== "number" ||
    !Number.isSafeInteger(x.seed) ||
    Number(x.seed) < 0 ||
    Number(x.seed) > 1_000_000 ||
    !Array.isArray(x.players) ||
    x.players.length !== 2 ||
    x.players.some((p) => typeof p !== "string" || !allowed.includes(p)) ||
    x.players[0] === x.players[1]
  )
    return null;
  return {
    mission: x.mission as LeagueMission,
    species: x.species as LeagueRequest["species"],
    durationSeconds: x.durationSeconds as 180 | 300,
    players: [...x.players] as string[],
    seed: Number(x.seed),
  };
}
export function labRequest(x: unknown): LabRequest | null {
  return record(x) &&
    typeof x.scenario === "string" &&
    ["no_rain", "fewer_predators"].includes(String(x.scenario)) &&
    typeof x.days === "number" &&
    [3, 7, 30].includes(x.days)
    ? { scenario: x.scenario as LabScenario, days: x.days as 3 | 7 | 30 }
    : null;
}
export function arenaCommand(x: unknown): ArenaCommand | null {
  if (!record(x) || typeof x.action !== "string") return null;
  if (
    x.action === "go_to" &&
    typeof x.x === "number" &&
    Number.isFinite(x.x) &&
    Math.abs(x.x) <= 10_000 &&
    typeof x.z === "number" &&
    Number.isFinite(x.z) &&
    Math.abs(x.z) <= 10_000 &&
    typeof x.gait === "string" &&
    ["walk", "trot", "run"].includes(x.gait)
  )
    return {
      action: "go_to",
      x: x.x,
      z: x.z,
      gait: x.gait as "walk" | "trot" | "run",
    };
  if (
    x.action === "hunt" &&
    typeof x.preyId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(x.preyId)
  )
    return { action: "hunt", preyId: x.preyId };
  return ["drink", "graze", "rest", "feed", "stop"].includes(String(x.action))
    ? { action: x.action as "drink" | "graze" | "rest" | "feed" | "stop" }
    : null;
}
