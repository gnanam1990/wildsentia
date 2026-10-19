/**
 * Animals a viewer asked for news of: kept in this browser (a per-viewer convenience), polled
 * every half minute, and told as a short line ("Blue duiker #2011 escaped an African leopard"),
 * in the page and, when the tab is hidden and the viewer allowed it, as a notification.
 */
export interface WatchEvent { id: string; type: string; worldTime: number; actors: string[]; outcome: string; conditions?: Record<string, unknown> }

const KEY = 'wildsentia.watch';
export const WATCH_LIMIT = 20;

const species = (id: string) => { const s = id.replace(/_[0-9a-z]+$/, '').replaceAll('_', ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const name = (id: string) => `${species(id)} #${id.slice(id.lastIndexOf('_') + 1)}`;
const a = (id: string) => { const s = species(id).toLowerCase(); return `${/^[aeiou]/.test(s) ? 'an' : 'a'} ${s}`; };

/** A line of news about a watched animal, or null for the everyday (eating, resting, walking). */
export function newsOf(animalId: string, e: WatchEvent): string | null {
  const me = name(animalId);
  if (e.type === 'hunt' && e.actors.length >= 2) {
    const [predator, prey] = e.actors as [string, string];
    if (prey === animalId) return e.outcome === 'success' ? `${me} was caught by ${a(predator)}.` : `${me} escaped ${a(predator)}.`;
    if (predator === animalId && e.outcome === 'success') return `${me} caught ${a(prey)}.`;
    return null;
  }
  if (e.type === 'died' && e.actors[0] === animalId) {
    const cause = typeof e.conditions?.cause === 'string' ? (e.conditions.cause as string).replaceAll('_', ' ') : '';
    return `${me} died${cause ? ` (${cause})` : ''}.`;
  }
  if (e.type === 'born' && e.actors[0] !== animalId && e.actors.includes(animalId)) return `${me} gave birth.`;
  return null;
}

/** The news in a page of events (newest first, as the server sends them) after a world time, oldest first. */
export function newsSince(animalId: string, events: readonly WatchEvent[], afterWorldTime: number): Array<{ id: string; worldTime: number; text: string }> {
  return events.filter((e) => e.worldTime > afterWorldTime).map((e) => ({ id: e.id, worldTime: e.worldTime, text: newsOf(animalId, e) }))
    .filter((n): n is { id: string; worldTime: number; text: string } => n.text !== null).sort((x, y) => x.worldTime - y.worldTime);
}

interface Stored { ids: string[]; seen: Record<string, number> }
/** The watched animals and the last world time each was told up to; empty if storage is blocked. */
export class Watchlist {
  #state: Stored = { ids: [], seen: {} };
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    try {
      const raw = storage?.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) as Partial<Stored> : null;
      if (parsed && Array.isArray(parsed.ids)) this.#state = { ids: parsed.ids.filter((x) => typeof x === 'string').slice(0, WATCH_LIMIT), seen: parsed.seen ?? {} };
    } catch { /* a fresh list */ }
  }
  get ids(): readonly string[] { return this.#state.ids; }
  has(id: string): boolean { return this.#state.ids.includes(id); }
  /** Starts or stops news of an animal; true if it is now watched. The oldest goes when the list is full. */
  toggle(id: string, nowWorldTime: number): boolean {
    if (this.has(id)) { this.#state.ids = this.#state.ids.filter((x) => x !== id); delete this.#state.seen[id]; this.#save(); return false; }
    this.#state.ids = [...this.#state.ids, id].slice(-WATCH_LIMIT);
    this.#state.seen[id] = nowWorldTime;
    this.#save();
    return true;
  }
  seen(id: string): number { return this.#state.seen[id] ?? 0; }
  told(id: string, worldTime: number): void { if (worldTime > this.seen(id)) { this.#state.seen[id] = worldTime; this.#save(); } }
  #save(): void { try { this.storage?.setItem(KEY, JSON.stringify(this.#state)); } catch { /* kept for this visit */ } }
}
