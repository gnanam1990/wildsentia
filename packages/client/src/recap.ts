export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Six world hours: shorter than that, a watcher has not really been away. */
const ABSENCE_SECONDS = 6 * 3600;

export function worthRecapping(lastSeen: number | null, now: number): boolean {
  return lastSeen !== null && now - lastSeen >= ABSENCE_SECONDS;
}

/**
 * When this browser last watched each animal, in world time. Kept only in this viewer's
 * browser, and only as a convenience: if storage is unavailable, recaps simply do not appear.
 */
export class LastSeen {
  constructor(private readonly storage: KeyValueStore | null) {}

  get(id: string): number | null {
    return this.cursor(id)?.worldTime ?? null;
  }

  cursor(id: string): { worldTime: number; nextSequence: number | null } | null {
    try {
      const raw = this.storage?.getItem(`vana.lastSeen.${id}`) ?? null;
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        return { worldTime: value, nextSequence: null }; // existing time-only browser memory
      if (typeof value !== 'object' || value === null) return null;
      const v = value as Record<string, unknown>;
      return v.version === 1 && typeof v.worldTime === 'number' && Number.isSafeInteger(v.worldTime) && v.worldTime >= 0
        && typeof v.nextSequence === 'number' && Number.isSafeInteger(v.nextSequence) && v.nextSequence >= 0
        ? { worldTime: v.worldTime, nextSequence: v.nextSequence } : null;
    } catch {
      return null;
    }
  }

  mark(id: string, worldTime: number, nextSequence?: number): void {
    if (!Number.isSafeInteger(worldTime) || worldTime < 0 || nextSequence !== undefined
      && (!Number.isSafeInteger(nextSequence) || nextSequence < 0)) return;
    try {
      this.storage?.setItem(`vana.lastSeen.${id}`, nextSequence === undefined ? String(worldTime)
        : JSON.stringify({ version: 1, worldTime, nextSequence }));
    } catch {
      // Private window or blocked storage: nothing to remember with, and nothing breaks.
    }
  }
}
