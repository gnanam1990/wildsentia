export type WorldTime = number;
export type Season = 'monsoon' | 'transition' | 'dry' | 'wet';

export const WORLD_SECONDS_PER_HOUR = 3600;
export const HOURS_PER_DAY = 24;
export const WORLD_SECONDS_PER_DAY = WORLD_SECONDS_PER_HOUR * HOURS_PER_DAY;
export const DAYS_PER_YEAR = 360;
export const WORLD_SECONDS_PER_YEAR = WORLD_SECONDS_PER_DAY * DAYS_PER_YEAR;

const SEASONS: readonly Season[] = ['monsoon', 'transition', 'dry', 'wet'];
/**
 * The Congo forest's year (Congo 1B): long rains, a drier spell, short rains, another drier
 * spell. A rainforest never has the island's dry season; its drier spells still rain.
 */
const CONGO_SEASONS: readonly Season[] = ['monsoon', 'transition', 'wet', 'transition'];

export function hourOfDay(t: WorldTime): number {
  return Math.floor((t % WORLD_SECONDS_PER_DAY) / WORLD_SECONDS_PER_HOUR);
}

export function minuteOfHour(t: WorldTime): number {
  return Math.floor((t % WORLD_SECONDS_PER_HOUR) / 60);
}

export function dayOfYear(t: WorldTime): number {
  return Math.floor((t % WORLD_SECONDS_PER_YEAR) / WORLD_SECONDS_PER_DAY) + 1;
}

export function yearOf(t: WorldTime): number {
  return Math.floor(t / WORLD_SECONDS_PER_YEAR) + 1;
}

/** The season at `t`. A world's profile picks its calendar; every world but Congo keeps the island's. */
export function seasonAt(t: WorldTime, profile?: string): Season {
  const seasons = profile === 'congo_v1' ? CONGO_SEASONS : SEASONS;
  const quarter = Math.floor((dayOfYear(t) - 1) / (DAYS_PER_YEAR / seasons.length));
  return seasons[quarter % seasons.length]!;
}

export function formatWorldTime(t: WorldTime, profile?: string): string {
  const y = String(yearOf(t)).padStart(2, '0');
  const d = String(dayOfYear(t)).padStart(2, '0');
  const h = String(hourOfDay(t)).padStart(2, '0');
  const m = String(minuteOfHour(t)).padStart(2, '0');
  return `Y${y}-${seasonAt(t, profile)}-D${d} ${h}:${m}`;
}
