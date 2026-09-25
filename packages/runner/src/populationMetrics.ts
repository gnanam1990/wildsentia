/** Observe every completed simulation step, including the initial population. */
export function recordPopulationPeaks(
  peaks: Record<string, number>, species: Iterable<string>, count: (id: string) => number,
): void {
  for (const id of species) peaks[id] = Math.max(peaks[id] ?? 0, count(id));
}
