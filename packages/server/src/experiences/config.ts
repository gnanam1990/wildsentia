import { EXPERIENCE_LOCAL_PLAYERS, type LeaguePlayer } from "@vana/shared";
export interface ExperienceConfig {
  origin: string | null;
  openRouterKey: string | null;
  models: LeaguePlayer[];
  modelDailyTokens: number;
  voice: {
    url: string;
    key: string;
    secret: string;
    agent: string;
    dailySeconds: number;
  } | null;
}
function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max: number,
): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  if (!/^[0-9]{1,9}$/.test(v) || Number(v) > max)
    throw new Error(`Invalid ${name}`);
  return Number(v);
}
export function experienceConfig(env: NodeJS.ProcessEnv): ExperienceConfig {
  const originRaw = env.VANA_EXPERIENCES_ORIGIN?.trim();
  let origin: string | null = null;
  if (originRaw) {
    const u = new URL(originRaw);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      (u.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
      throw new Error("Invalid VANA_EXPERIENCES_ORIGIN");
    origin = u.origin;
  }
  const key = env.OPENROUTER_API_KEY?.trim() || null;
  const ids = [
    ...new Set(
      (env.VANA_LEAGUE_MODELS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (
    ids.length > 8 ||
    ids.some(
      (id) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(
          id,
        ),
    )
  )
    throw new Error("Invalid VANA_LEAGUE_MODELS");
  const models: LeaguePlayer[] =
    key && env.VANA_LEAGUE_PUBLIC_MODELS === "1"
      ? ids.map((id) => ({
          id: `openrouter:${id}`,
          label: id,
          source: "openrouter",
        }))
      : [];
  let voice: ExperienceConfig["voice"] = null;
  if (env.VANA_SAFARI_LIVEKIT === "1") {
    const url = env.LIVEKIT_URL?.trim(),
      lkKey = env.LIVEKIT_API_KEY?.trim(),
      secret = env.LIVEKIT_API_SECRET?.trim();
    if (!url || !lkKey || !secret)
      throw new Error(
        "LiveKit Safari needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
      );
    const u = new URL(url);
    if (u.protocol !== "wss:" || u.username || u.password || u.search || u.hash)
      throw new Error("Invalid LIVEKIT_URL");
    voice = {
      url,
      key: lkKey,
      secret,
      agent: "wildsentia-safari",
      dailySeconds: integer(env, "VANA_VOICE_DAILY_SECONDS", 1800, 86_400),
    };
  }
  return {
    origin,
    openRouterKey: key,
    models: [...EXPERIENCE_LOCAL_PLAYERS, ...models],
    modelDailyTokens: integer(
      env,
      "VANA_LEAGUE_DAILY_TOKENS",
      200_000,
      5_000_000,
    ),
    voice,
  };
}
