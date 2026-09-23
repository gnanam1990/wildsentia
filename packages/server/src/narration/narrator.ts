import { recapFor, recapLine, type RecapLine, type WorldEvent } from '@vana/shared';
import type { Pool } from '../db/pool.js';
import { isGrounded } from './grounding.js';

/** Rewords one template line for tone. Returns the text, the tokens it cost, and the model. */
export type Rephraser = (template: string) => Promise<{ text: string; tokens: number; model: string }>;

/** Bump when the templates or the model prompt change, so old rewrites are not reused. */
export const NARRATION_VERSION = 'n1';

/**
 * Events worth a model's attention. Everything else — and everything, when there is no model or
 * the day's budget is spent — is told by its template alone (spec §9.3).
 */
const MAJOR = new Set(['born', 'died', 'hunt', 'courtship', 'skill_taught', 'dispersed']);

export interface NarratedLine extends RecapLine {
  /** True when a grounded model rewording replaced the template. */
  narrated: boolean;
}

export interface NarratorOptions {
  pool: Pool;
  rephrase: Rephraser | null;
  /** Tokens the model may spend per UTC day before narration falls back to templates. */
  dailyTokenBudget: number;
}

/**
 * The one-way valve (spec §9.2): event → template → optional model → grounding check → reader.
 * It reads the event log and writes only its own cache; it holds no handle on the world, so a
 * model can change how a line reads and nothing else. Recaps never wait on a model: they show
 * what is cached and queue the rest, and a watcher sees the rewording on their next look.
 */
export class Narrator {
  readonly #pool: Pool;
  readonly #rephrase: Rephraser | null;
  readonly #budget: number;
  #day = '';
  #spent = 0;
  #queue: Promise<void> = Promise.resolve();
  readonly #queued = new Set<string>();

  constructor(options: NarratorOptions) {
    this.#pool = options.pool;
    this.#rephrase = options.rephrase;
    this.#budget = options.dailyTokenBudget;
  }

  async recap(events: readonly WorldEvent[], subjectId: string): Promise<NarratedLine[]> {
    const lines = recapFor(events, subjectId);
    const ids = lines.map((l) => l.eventId);
    const cached = new Map<string, { text: string; grounded: boolean }>();
    if (ids.length > 0) {
      const { rows } = await this.#pool.query<{ event_id: string; text: string; grounded: boolean }>(
        'select event_id, text, grounded from narrations where subject_id = $1 and version = $2 and event_id = any($3::text[])',
        [subjectId, NARRATION_VERSION, ids],
      );
      for (const row of rows) cached.set(row.event_id, { text: row.text, grounded: row.grounded });
    }

    const byId = new Map(events.map((e) => [e.id, e]));
    return lines.map((line) => {
      const hit = cached.get(line.eventId);
      if (hit?.grounded) return { ...line, text: hit.text, narrated: true };
      const event = byId.get(line.eventId);
      // A folded line ("×3") is a summary of several events; leave it to its template.
      if (hit === undefined && event !== undefined && MAJOR.has(event.type) && !line.text.includes('×')) {
        this.#enqueue(event, subjectId);
      }
      return { ...line, narrated: false };
    });
  }

  /** Resolves when everything queued so far has been narrated or skipped. */
  idle(): Promise<void> {
    return this.#queue;
  }

  #enqueue(event: WorldEvent, subjectId: string): void {
    const key = `${event.id}|${subjectId}`;
    if (this.#rephrase === null || this.#queued.has(key)) return;
    this.#queued.add(key);
    // One at a time: narration is a garnish, and must never compete with the world for resources.
    this.#queue = this.#queue
      .then(() => this.#narrate(event, subjectId))
      .catch((error: unknown) => { console.warn('narration failed; template kept', error); })
      .finally(() => { this.#queued.delete(key); });
  }

  async #narrate(event: WorldEvent, subjectId: string): Promise<void> {
    const template = recapLine(event, subjectId)?.text;
    if (template === undefined || !this.#withinBudget()) return;

    const { text, tokens, model } = await this.#rephrase!(template);
    this.#spent += tokens;
    const grounded = isGrounded(template, text);
    await this.#pool.query(
      `insert into narrations (event_id, subject_id, version, text, grounded, model)
       values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
      [event.id, subjectId, NARRATION_VERSION, text.trim(), grounded, model],
    );
  }

  #withinBudget(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.#day) { this.#day = today; this.#spent = 0; }
    return this.#spent < this.#budget;
  }
}
