import type { WorldStore } from './protocol.js';
import { modelStatusForAnimal } from './species.js';
import { validNextCursor } from './historyCursor.js';

/**
 * Every value shown here is read from the store, which holds only what the server said.
 * Where the simulation reports nothing, the HUD shows a dash and says so — it never fills
 * a gap with a plausible-looking number.
 */
const UNKNOWN = '<span class="unknown" title="not reported by the simulation">&mdash;</span>';

const pct = (value: number | undefined): string =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : UNKNOWN;

const bar = (label: string, value: number | undefined, colour: string): string => {
  const width = typeof value === 'number' ? Math.round(value * 100) : 0;
  return `<div class="meter"><span>${label}</span>
    <span class="track"><i style="width:${width}%;background:${colour}"></i></span>
    <b>${pct(value)}</b></div>`;
};

/** The passport as the server reports it: live state and the event log, nothing authored. */
export interface Passport {
  asOfWorldTime?: number;
  nextEventSequence?: number;
  id: string; speciesId: string; displayName: string; sex: string; ageDays: number;
  lifeStage: string; generation: number; alive: boolean; massKg: number;
  thought: { text: string; basis: string[]; confident: boolean } | null;
  lineage: {
    mother: { id: string; alive: boolean } | null;
    father: { id: string; alive: boolean } | null;
    offspring: Array<{ id: string; alive: boolean }>;
  };
  skills: Array<{ skill: string; confidence: number; taughtBy: string | null }>;
  death: { cause: string; worldTime: number; eventId: string } | null;
  timeline: Array<{ id: string; type: string; worldTime: number; outcome: string }>;
}

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const age = (days: number): string =>
  days >= 365 ? `${(days / 365).toFixed(1)} years` : `${Math.round(days)} days`;

const SKILL_LABEL: Record<string, string> = {
  forage_efficiency: 'Foraging', water_locations: 'Knows the water',
  predator_avoidance: 'Evading predators', stalk_technique: 'Stalking',
};

const EVENT_LABEL: Record<string, string> = {
  agent_spawned: 'Animal entered the world', birth: 'Birth', death: 'Death',
  fed: 'Fed', drank: 'Drank water', hunt: 'Hunt', human_hunt: 'Village hunt',
  human_task_finished: 'Village task finished', human_task_started: 'Village task started',
  tree_climbed: 'Climbed a tree', illness_started: 'Illness began', illness_ended: 'Illness ended',
  flowering_started: 'Modelled flowering began',
  flower_visitation_settled: 'Modelled insect visitation settled',
  seeds_matured: 'Modelled seeds matured',
  plants_recruited: 'Modelled plants recruited',
  seed_bank_lost: 'Modelled seed bank lost',
};
const FLOWERING_EVENT_TYPES = new Set(['flowering_started', 'flower_visitation_settled',
  'seeds_matured', 'plants_recruited', 'seed_bank_lost']);

/** Short, factual labels for the live feed. Event IDs remain available on disclosure. */
export function feedEventSummary(event: Record<string, unknown>): { title: string; meta: string; id: string } {
  const type = typeof event.type === 'string' ? event.type : 'event';
  const title = EVENT_LABEL[type] ?? type.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
  const actors = Array.isArray(event.actors) ? event.actors.filter((id): id is string => typeof id === 'string') : [];
  const actor = FLOWERING_EVENT_TYPES.has(type)
    ? Number.isSafeInteger(event.patchId) && (event.patchId as number) >= 0
      ? `patch ${event.patchId} · aggregate guild` : 'patch not recorded · aggregate guild'
    : actors.length > 0 ? actors.slice(0, 2).join(' + ') : 'actor not recorded';
  const time = typeof event.worldTime === 'number' && Number.isFinite(event.worldTime) && event.worldTime >= 0
    ? `day ${Math.floor(event.worldTime / 86_400) + 1}, ${String(Math.floor(event.worldTime / 3600) % 24).padStart(2, '0')}:${String(Math.floor(event.worldTime / 60) % 60).padStart(2, '0')}`
    : 'time not recorded';
  const outcome = typeof event.outcome === 'string' ? ` · ${event.outcome.replaceAll('_', ' ')}` : '';
  return { title, meta: `${actor} · ${time}${outcome}`, id: typeof event.id === 'string' ? event.id : 'not recorded' };
}

const kinLink = (kin: { id: string; alive: boolean } | null): string => kin === null
  ? '<span class="unknown" title="a founder or immigrant: no parent in the record">none recorded</span>'
  : `<a href="#" data-follow="${escape(kin.id)}">${escape(kin.id)}</a>${kin.alive ? '' : ' <i>(dead)</i>'}`;

export interface HudElements {
  clock: HTMLElement;
  season: HTMLElement;
  population: HTMLElement;
  passport: HTMLElement;
  feed: HTMLElement;
  notice: HTMLElement;
}

export class Hud {
  /** The last passport fetched for the followed animal, refreshed every few seconds. */
  passport: Passport | null = null;
  /** What happened to the followed animal while this viewer was away, until dismissed. */
  recap: { id: string; days: number; totalLines: number; lines: Array<{ eventId: string; text: string; narrated?: boolean }> } | null = null;
  recapStatus: { id: string; text: string } | null = null;
  #recapAbort: AbortController | null = null;
  #recapRequest = 0;
  #passportRequest = 0;

  cancelRecap(): void { this.#recapRequest++; this.#recapAbort?.abort(); this.recap = null; this.recapStatus = null; }

  async loadRecap(id: string, since: number, _now: number, sinceSequence?: number | null): Promise<false | { worldTime: number; nextSequence: number }> {
    const request = ++this.#recapRequest;
    this.#recapAbort?.abort(); this.#recapAbort = new AbortController();
    this.recapStatus = { id, text: 'Loading missed history…' };
    try {
      const sequence = sinceSequence == null ? '' : `&sinceSequence=${sinceSequence}`;
      const path = `/api/animals/${encodeURIComponent(id)}/recap`;
      let query = `?since=${since}${sequence}`, pages = 0, totalLines = 0;
      let boundary: { worldTime: number; nextSequence: number } | null = null;
      let lines: NonNullable<Hud['recap']>['lines'] = [];
      const seen = new Set<string>();
      do {
        const response = await fetch(path + query, { signal: AbortSignal.any([this.#recapAbort.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('History unavailable');
        const body = await response.json();
        if (request !== this.#recapRequest) return false;
        if (!Number.isSafeInteger(body.until) || body.until < 0 || !Number.isSafeInteger(body.nextEventSequence) || body.nextEventSequence < 0
          || !validNextCursor(body.nextCursor) || !Array.isArray(body.lines) || body.lines.length > 200
          || !body.lines.every((l: { eventId?: unknown; text?: unknown }) => l && typeof l.eventId === 'string' && typeof l.text === 'string'))
          throw new Error('Invalid recap page');
        if (boundary && (body.until !== boundary.worldTime || body.nextEventSequence !== boundary.nextSequence)) throw new Error('Mixed checkpoints');
        boundary = { worldTime: body.until, nextSequence: body.nextEventSequence };
        totalLines += body.lines.length; lines = [...lines, ...body.lines].slice(-12); pages++;
        this.recapStatus = { id, text: `Loading missed history · ${pages} pages checked…` };
        if (body.nextCursor === null) break;
        if (seen.has(body.nextCursor)) throw new Error('Repeating history cursor');
        seen.add(body.nextCursor); query = `?cursor=${encodeURIComponent(body.nextCursor)}`;
      } while (request === this.#recapRequest);
      if (request !== this.#recapRequest || !boundary) return false;
      this.recap = { id, days: (boundary.worldTime - since) / 86_400, lines, totalLines };
      this.recapStatus = null;
      return boundary;
    } catch {
      if (request === this.#recapRequest) { this.recap = null; this.recapStatus = { id, text: 'Missed history unavailable. Retrying; your previous visit is still saved.' }; }
      return false;
    }
  }

  constructor(private readonly elements: HudElements, private readonly store: WorldStore) {}

  async refreshPassport(id: string | null): Promise<void> {
    const request = ++this.#passportRequest;
    if (id === null) { this.passport = null; return; }
    try {
      const response = await fetch(`/api/animals/${encodeURIComponent(id)}/passport`);
      const passport = response.ok ? (await response.json()) as Passport : null;
      if (request === this.#passportRequest) this.passport = passport;
    } catch {
      if (request === this.#passportRequest) this.passport = null;
    }
  }

  render(followedId: string | null): void {
    const world = this.store.world;
    this.elements.clock.innerHTML = world?.formatted ?? UNKNOWN;
    this.elements.season.innerHTML = world?.season ?? UNKNOWN;
    this.elements.population.innerHTML = world
      ? Object.entries(world.population)
          .map(([species, n]) => `<span>${species} <b>${n}</b></span>`)
          .join('')
      : UNKNOWN;

    this.elements.notice.textContent = this.store.lastError ?? '';

    if (followedId === null) {
      this.elements.passport.innerHTML =
        '<p class="hint">Click an animal to follow it.</p>';
      return;
    }

    const animal = this.store.animals.get(followedId);
    const p = this.passport?.id === followedId ? this.passport : null;
    if (animal === undefined) {
      this.elements.passport.innerHTML = p?.death
        ? `<h2>${escape(p.id)}</h2><div class="sub">${escape(p.displayName)} &middot; died aged ${age(p.ageDays)}</div>
           <div class="row"><span>Cause</span><b>${escape(p.death.cause)}</b></div>
           <div class="row"><span>Record</span><b class="eid">${escape(p.death.eventId)}</b></div>
           ${this.#recapCard(followedId)}${this.#lineage(p)}
           <button data-history="${escape(p.id)}" aria-haspopup="dialog">Browse retained history</button>
           <button data-replay="${escape(p.id)}">Replay this life</button>
           ${this.shareButton(p.id)}`
        : `<p class="hint">${escape(followedId)} is no longer reported by the live simulation.</p>
           ${p ? `${this.#recapCard(followedId)}<button data-history="${escape(p.id)}" aria-haspopup="dialog">Browse retained history</button>
           <button data-replay="${escape(p.id)}">Replay this life</button>${this.shareButton(p.id)}` : ''}`;
      return;
    }

    const viewers = this.store.viewerCounts.get(followedId);
    const identity = p === null
      ? `${animal.speciesId} &middot; patch ${animal.patchId}`
      : `${escape(p.displayName)} &middot; ${escape(p.sex)} &middot; ${escape(p.lifeStage)} &middot; ${age(p.ageDays)} &middot; generation ${p.generation}`;
    this.elements.passport.innerHTML = `${this.#recapCard(followedId)}
      <h2>${escape(animal.id)}</h2>
      <div class="sub">${identity}</div>
      <p class="hint">Visual: ${escape(modelStatusForAnimal(animal))}</p>
      ${bar('Hunger', animal.drives.hunger, 'var(--clay)')}
      ${bar('Thirst', animal.drives.thirst, 'var(--mist)')}
      ${bar('Fatigue', animal.drives.fatigue, 'var(--ink-3)')}
      ${bar('Fear', animal.drives.fear, 'var(--blood)')}
      <div class="row"><span>State</span><b>${escape(animal.state)}</b></div>
      ${animal.illnessStatus === 'symptomatic'
        ? '<div class="row"><span>Health</span><b>Modelled illness symptoms</b></div>' : ''}
      ${animal.woundStatus
        ? `<div class="row"><span>Injury</span><b>Modelled ${animal.woundStatus === 'infected' ? 'wound infection' : 'open wound'}</b></div>` : ''}
      <div class="row"><span>Goal</span><b>${escape(animal.currentGoal)}</b></div>
      <div class="row"><span>Watching now</span><b>${viewers ?? UNKNOWN}</b></div>
      ${p === null ? '' : this.#skills(p) + this.#lineage(p) + this.#timeline(p)}
      <button data-replay="${escape(animal.id)}">Replay this life</button>
      <button data-history="${escape(animal.id)}" aria-haspopup="dialog">Browse retained history</button>
      ${this.shareButton(animal.id)}
      <p class="prov">${animal.position ? 'Positions are recorded by the server; paths between updates are interpolated, not collision-aware.' : 'Legacy patch-only data: within-patch placement is approximate.'} Visual coverage is asset metadata. Narration never changes outcomes.</p>`;
  }

  private shareButton(id: string): string {
    return `<button data-share="${escape(id)}" aria-haspopup="dialog">Share animal story</button>`;
  }

  #recapCard(id: string): string {
    if (this.recapStatus?.id === id) return `<p role="status">${escape(this.recapStatus.text)}</p>`;
    const r = this.recap;
    if (r === null || r.id !== id) return '';
    const away = r.days >= 1 ? `${r.days.toFixed(1)} world days` : `${Math.round(r.days * 24)} world hours`;
    const body = r.lines.length === 0
      ? '<p class="hint">No narrated significant events in this retained interval.</p>'
      : r.lines.slice(-12).map((l) => `<div class="event${l.narrated === true ? ' narrated' : ''}"
          ${l.narrated === true ? 'title="The event fact clause is unchanged; only a neutral prefix is allowed"' : ''}>
          <div class="etype">${escape(l.text)}</div><div class="eid">${escape(l.eventId)}</div></div>`).join('');
    const reworded = r.lines.some((l) => l.narrated === true);
    return `<section class="recap"><h3>While you were away &middot; ${away}</h3>${body}
      ${r.totalLines > 12 ? `<p class="prov">Latest 12 of ${r.totalLines} summary lines. Use Browse retained history for the event records.</p>` : ''}
      ${reworded ? '<p class="prov">lines marked &#9998; were reworded by a model from the event shown beside them</p>' : ''}
      <button data-dismiss-recap>Got it</button></section>`;
  }

  #skills(p: Passport): string {
    if (p.skills.length === 0) return '';
    return `<h3>What it knows</h3>${p.skills.map((s) => `
      ${bar(SKILL_LABEL[s.skill] ?? s.skill, s.confidence, 'var(--moss, #7fa35a)')}
      <div class="taught">${s.taughtBy === null ? 'self-taught or innate' : `taught by ${kinLink({ id: s.taughtBy, alive: true })}`}</div>`).join('')}`;
  }

  #lineage(p: Passport): string {
    const living = p.lineage.offspring.filter((o) => o.alive).length;
    return `<h3>Family</h3>
      <div class="row"><span>Mother</span><b>${kinLink(p.lineage.mother)}</b></div>
      <div class="row"><span>Father</span><b>${kinLink(p.lineage.father)}</b></div>
      <div class="row"><span>Young</span><b>${p.lineage.offspring.length} (${living} alive)</b></div>`;
  }

  #timeline(p: Passport): string {
    if (p.timeline.length === 0) return '';
    return `<h3>Life so far</h3><div class="timeline">${p.timeline.slice(0, 12).map((e) => `
      <div class="event"><div class="etype">${escape(e.type)} <i>${escape(e.outcome)}</i></div>
      <div class="eid">${escape(e.id)}</div></div>`).join('')}</div>`;
  }

  async refreshFeed(): Promise<void> {
    try {
      const response = await fetch('/api/events?limit=12');
      if (!response.ok) throw new Error('Event feed unavailable');
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      if (!Array.isArray(body.events)) throw new Error('Invalid event feed');
      this.elements.feed.innerHTML = body.events
        .map((event) => {
          const item = feedEventSummary(event);
          return `<div class="event feed-entry"><div>
            <div class="etype">${escape(item.title)}</div>
            <div class="feed-meta">${escape(item.meta)}</div>
            <details class="feed-provenance"><summary>Record ID</summary><code>${escape(item.id)}</code></details>
          </div></div>`;
        })
        .join('');
    } catch {
      this.elements.feed.innerHTML = '<p class="hint">event feed unavailable</p>';
    }
  }
}
