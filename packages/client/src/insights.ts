import { feedSentence, friendlyWorldTime, happenedBy } from './hud.js';

/**
 * Observer insights from the server's TypeSafe AI (Jev) integration: a followed animal's
 * likely next hour, and the most remarkable of the latest recorded moments. Both are
 * estimates about saved state, labelled as such; when the server has no key they are absent
 * and nothing is shown.
 */

export interface OutlookChoice { goal: string; label: string; probability: number }
export type OutlookBody =
  | { available: true; asOfWorldTime: number; model: string; confidence: number; choices: OutlookChoice[]; notice: string }
  | { available: false; reason: string };
export interface HighlightItem { event: Record<string, unknown>; score: number; confidence: number }
export type HighlightsBody =
  | { available: true; asOfWorldTime: number; model: string; highlights: HighlightItem[]; notice: string }
  | { available: false; reason: string };

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SHORT: Record<string, string> = {
  find_food: 'Look for food', find_water: 'Drink', rest: 'Rest', wander: 'Move on', hunt: 'Hunt',
  scavenge: 'Scavenge', flee: 'Flee', breed: 'Find a mate', care_for_young: 'Tend its young', follow_parent: 'Follow mother',
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const text = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only replies every field of which the card can draw; anything else shows nothing. */
export function validOutlook(body: unknown): body is OutlookBody {
  if (!record(body)) return false;
  const b = body;
  if (b.available === false) return typeof b.reason === 'string';
  return b.available === true && finite(b.asOfWorldTime) && finite(b.confidence) && text(b.model, 200) && text(b.notice)
    && Array.isArray(b.choices) && b.choices.length <= 50
    && b.choices.every((c) => record(c) && text(c.goal, 100) && text(c.label, 500) && finite(c.probability));
}

export function validHighlights(body: unknown): body is HighlightsBody {
  if (!record(body)) return false;
  const b = body;
  if (b.available === false) return typeof b.reason === 'string';
  return b.available === true && text(b.model, 200) && text(b.notice) && Array.isArray(b.highlights) && b.highlights.length <= 50
    && b.highlights.every((h) => record(h) && record(h.event) && finite(h.score));
}

/** The likely next hour as bars, most likely first; empty when there is nothing to show. */
export function outlookHtml(body: OutlookBody | null): string {
  if (!body || !body.available || body.choices.length === 0) return '';
  const rows = body.choices.slice(0, 4).map((c) => {
    const percent = Math.round(Math.max(0, Math.min(1, c.probability)) * 100);
    return `<div class="meter" title="${escape(c.label)}"><span>${escape(SHORT[c.goal] ?? c.goal)}</span>
      <span class="track"><i style="width:${percent}%;background:var(--mist)"></i></span><b>${percent}%</b></div>`;
  }).join('');
  const sure = body.confidence >= 0.66 ? 'fairly sure' : body.confidence >= 0.33 ? 'unsure' : 'very unsure';
  return `<details class="outlook" open><summary>What's likely next?</summary>${rows}
    <p class="hint">Estimate for the next hour (${sure}) · ${escape(body.model)}. ${escape(body.notice)}</p></details>`;
}

/** Up to three standout moments, above the plain chronological feed. */
export function highlightsHtml(body: HighlightsBody | null, time: number | null = null): string {
  if (!body || !body.available) return '';
  // Nothing before it has happened on screen: the saved hour runs ahead of the played one.
  const shown = body.highlights.filter((h) => happenedBy([h.event], time).length > 0);
  if (shown.length === 0) return '';
  const items = shown.map((h) => {
    const when = finite(h.event.worldTime) ? friendlyWorldTime(h.event.worldTime).replace(/^Year \d+ · /, '') : '';
    return `<div class="event feed-entry highlight"><div><div class="etype">${escape(feedSentence(h.event))}</div>
      <div class="feed-meta">${escape(when)} · <span title="Remarkableness, 0-4">★ ${h.score.toFixed(1)}</span></div></div></div>`;
  }).join('');
  return `<div class="highlights"><h4>Highlights</h4>${items}
    <p class="hint">Picked by ${escape(body.model)} from the latest records.</p></div>`;
}

export class InsightPanel {
  #outlookFor: string | null = null;
  #outlookRequest = 0;

  constructor(private readonly outlookEl: HTMLElement, private readonly highlightsEl: HTMLElement,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly clock: () => number | null = () => null) {}

  /** Shows the followed animal's likely next hour; null clears it. Stale replies are dropped. */
  async outlook(id: string | null): Promise<void> {
    const request = ++this.#outlookRequest;
    if (id !== this.#outlookFor) { this.#outlookFor = id; this.outlookEl.innerHTML = ''; }
    if (id === null) return;
    let body: OutlookBody | null = null;
    try {
      const response = await this.fetchImpl(`/api/insights/animals/${encodeURIComponent(id)}/outlook`);
      const json: unknown = response.ok ? await response.json() : null;
      body = validOutlook(json) ? json : null;
    } catch { body = null; }
    if (request !== this.#outlookRequest) return;
    this.outlookEl.innerHTML = outlookHtml(body);
  }

  async highlights(): Promise<void> {
    let body: HighlightsBody | null = null;
    try {
      const response = await this.fetchImpl('/api/insights/highlights');
      const json: unknown = response.ok ? await response.json() : null;
      body = validHighlights(json) ? json : null;
    } catch { body = null; }
    this.highlightsEl.innerHTML = highlightsHtml(body, this.clock());
  }
}
