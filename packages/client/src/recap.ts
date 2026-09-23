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
    try {
      const raw = this.storage?.getItem(`vana.lastSeen.${id}`) ?? null;
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  mark(id: string, worldTime: number): void {
    try {
      this.storage?.setItem(`vana.lastSeen.${id}`, String(worldTime));
    } catch {
      // Private window or blocked storage: nothing to remember with, and nothing breaks.
    }
  }
}
