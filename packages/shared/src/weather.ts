/**
 * Showers for the observer. The simulation rains at a steady seasonal rate (fields/water.ts);
 * seen that way the monsoon was one endless drizzle. This spreads the same season into
 * showers and dry spells: a pure function of world time and season, so every viewer sees the
 * same shower at the same moment and nothing in the world's state is changed.
 */

/** Share of the time it is raining in each season. */
export const SHOWER_SHARE: Readonly<Record<string, number>> = { monsoon: 0.55, wet: 0.3, transition: 0.1, dry: 0.02 };

const hash = (n: number, salt: number): number => {
  let h = Math.imul(n ^ salt, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
};

/** Smooth value noise over time, 0-1, changing on the scale of `period` hours. */
const noise = (hours: number, period: number, salt: number): number => {
  const t = hours / period, i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return hash(i, salt) * (1 - u) + hash(i + 1, salt) * u;
};

const showerNoise = (hours: number): number => 0.65 * noise(hours, 3.1, 0x51a7) + 0.35 * noise(hours, 0.8, 0x7c21);

/** The noise level above which a season's share of time is rainy, measured once from the noise itself. */
const thresholds = new Map<number, number>();
function thresholdFor(share: number): number {
  let value = thresholds.get(share);
  if (value === undefined) {
    const samples: number[] = [];
    for (let h = 0; h < 20_000; h += 0.37) samples.push(showerNoise(h));
    samples.sort((a, b) => a - b);
    value = samples[Math.min(samples.length - 1, Math.floor((1 - share) * samples.length))]!;
    thresholds.set(share, value);
  }
  return value;
}

/**
 * How hard it is raining, 0 (dry) to 1 (downpour), at a world time. Over many days the share
 * of rainy time matches SHOWER_SHARE for the season.
 */
export function showerIntensity(worldTime: number, season: string): number {
  const share = SHOWER_SHARE[season] ?? 0;
  if (!Number.isFinite(worldTime) || share <= 0) return 0;
  // Weather systems over a few hours, with showers passing through within the hour.
  const n = showerNoise(worldTime / 3600);
  const threshold = thresholdFor(share);
  return n <= threshold ? 0 : Math.min(1, (n - threshold) / 0.12);
}
