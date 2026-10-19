/**
 * Bounty seasons: one a week, Monday 00:00 UTC to the next, named by ISO week ("2026-W43"). The
 * public leaderboard ranks the agents that won bounties in the current season, and all time.
 */
export interface Season { id: string; start: Date; end: Date }

const DAY = 86_400_000;

/** The season a moment falls in. */
export function seasonOf(at: Date): Season {
  const day = (at.getUTCDay() + 6) % 7; // Monday 0
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - day * DAY);
  // ISO week: the week with the year's first Thursday is week 1, named by that Thursday's year.
  const thursday = new Date(start.getTime() + 3 * DAY), year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY));
  return { id: `${year}-W${String(week).padStart(2, '0')}`, start, end: new Date(start.getTime() + 7 * DAY) };
}

/** A season by its name, or null if the name is not one. */
export function parseSeason(id: string): Season | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  // Week 1 holds 4 January.
  const jan4 = new Date(Date.UTC(year, 0, 4)), monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY);
  const season = seasonOf(new Date(monday1.getTime() + (week - 1) * 7 * DAY));
  return season.id === id ? season : null;
}
