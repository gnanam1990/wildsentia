export type WorldTime = number;
export type Season = 'monsoon' | 'transition' | 'dry' | 'wet';

export const WORLD_SECONDS_PER_HOUR = 3600;
export const HOURS_PER_DAY = 24;
export const WORLD_SECONDS_PER_DAY = WORLD_SECONDS_PER_HOUR * HOURS_PER_DAY;
export const DAYS_PER_YEAR = 360;
export const WORLD_SECONDS_PER_YEAR = WORLD_SECONDS_PER_DAY * DAYS_PER_YEAR;

const SEASONS: readonly Season[] = ['monsoon', 'transition', 'dry', 'wet'];

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

export function seasonAt(t: WorldTime): Season {
  const quarter = Math.floor((dayOfYear(t) - 1) / (DAYS_PER_YEAR / SEASONS.length));
  return SEASONS[quarter % SEASONS.length]!;
}

export function formatWorldTime(t: WorldTime): string {
  const y = String(yearOf(t)).padStart(2, '0');
  const d = String(dayOfYear(t)).padStart(2, '0');
  const h = String(hourOfDay(t)).padStart(2, '0');
  const m = String(minuteOfHour(t)).padStart(2, '0');
  return `Y${y}-${seasonAt(t)}-D${d} ${h}:${m}`;
}
