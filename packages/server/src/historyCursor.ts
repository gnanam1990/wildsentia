import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EventBoundary } from './db/eventStore.js';

export interface HistoryCursor {
  version: 1;
  scope: string;
  boundary: EventBoundary;
  after: { worldTime: number; id: string } | null;
  since: number;
  sinceSequence: number | null;
}
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** API-instance signatures bind pagination to its original committed history, not request-supplied bounds.
 * Restart invalidates cursors deliberately: the reader must begin again against the recovered world. */
export class HistoryCursors {
  readonly #key = randomBytes(32);
  encode(cursor: HistoryCursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${createHmac('sha256', this.#key).update(body).digest('base64url')}`;
  }
  decode(raw: string, scope: string, current: EventBoundary): HistoryCursor | null {
    if (raw.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(raw)) return null;
    const [body, tag] = raw.split('.') as [string, string];
    const expected = createHmac('sha256', this.#key).update(body).digest();
    const supplied = Buffer.from(tag, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as HistoryCursor;
      if (v?.version !== 1 || v.scope !== scope || !integer(v.boundary?.worldTime)
        || !integer(v.boundary?.nextSequence)
        || v.after !== null && (!integer(v.after?.worldTime) || typeof v.after?.id !== 'string' || !v.after.id || v.after.id.length > 256)
        || !Number.isSafeInteger(v.since) || v.since < -1
        || v.sinceSequence !== null && !integer(v.sinceSequence)
        || v.after !== null && v.after.worldTime > v.boundary.worldTime || v.boundary.worldTime > current.worldTime
        || v.boundary.nextSequence > current.nextSequence) return null;
      return v;
    } catch { return null; }
  }
}

export function historyLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= 500 ? n : null;
}
