/** The world clock as a visitor reads it: "Year 1 · Day 5 · 3 pm". */
export function friendlyWorldTime(worldTime: number): string {
  if (!Number.isFinite(worldTime) || worldTime < 0) return '—';
  const day = Math.floor(worldTime / 86_400), hour = Math.floor(worldTime / 3600) % 24;
  const clock = hour === 0 ? '12 am' : hour < 12 ? `${hour} am` : hour === 12 ? '12 pm' : `${hour - 12} pm`;
  return `Year ${Math.floor(day / 360) + 1} · Day ${(day % 360) + 1} · ${clock}`;
}
