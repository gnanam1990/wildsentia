import type { WorldStore } from './protocol.js';
import { withTimeout } from './abortSignals.js';
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

/** The world clock as a visitor reads it: "Year 1 · Day 5 · 3 pm". */
export function friendlyWorldTime(worldTime: number): string {
  if (!Number.isFinite(worldTime) || worldTime < 0) return '—';
  const day = Math.floor(worldTime / 86_400), hour = Math.floor(worldTime / 3600) % 24;
  const clock = hour === 0 ? '12 am' : hour < 12 ? `${hour} am` : hour === 12 ? '12 pm' : `${hour - 12} pm`;
  return `Year ${Math.floor(day / 360) + 1} · Day ${(day % 360) + 1} · ${clock}`;
}

const SPECIES_NAME: Record<string, string> = {
  chital: 'chital', sambar: 'sambar', gaur: 'gaur', dhole: 'dhole', jackal: 'jackal', boar: 'wild boar',
  tiger: 'tiger', leopard: 'leopard', elephant: 'elephant', langur: 'langur', squirrel: 'giant squirrel', hare: 'hare', vulture: 'vulture',
  human: 'villager',
};
const speciesOf = (id: string | undefined): string | null => {
  if (!id) return null;
  const prefix = id.split('_')[0] ?? '';
  return SPECIES_NAME[prefix] ?? null;
};
const an = (noun: string) => (/^[aeiou]/i.test(noun) ? `An ${noun}` : `A ${noun}`);

/**
 * One plain sentence for the "Happening now" list, from the event's type, outcome and the
 * species in its actor IDs. Falls back to the factual label when a type has no sentence.
 */
export function feedSentence(event: Record<string, unknown>): string {
  const type = typeof event.type === 'string' ? event.type : '';
  const outcome = typeof event.outcome === 'string' ? event.outcome : '';
  const actors = Array.isArray(event.actors) ? event.actors.filter((id): id is string => typeof id === 'string') : [];
  const [first, second] = [speciesOf(actors[0]), speciesOf(actors[1])];
  const failed = outcome === 'failed' || outcome === 'interrupted';
  if (first !== null) {
    switch (type) {
      case 'hunt': return second ? (outcome === 'success' ? `${an(first)} caught ${an(second).toLowerCase()}` : `${an(first)}'s hunt for ${an(second).toLowerCase()} failed`) : `${an(first)} hunted`;
      case 'human_hunt': return outcome === 'success' ? 'Villagers brought back a catch' : 'A village hunt came back empty';
      case 'scavenged': return second ? `${an(first)} fed on ${an(second).toLowerCase()} carcass` : `${an(first)} scavenged`;
      case 'fed': return ['tiger', 'leopard', 'dhole', 'jackal'].includes(first) ? `${an(first)} ate` : `${an(first)} grazed`;
      case 'drank': return `${an(first)} drank water`;
      case 'rested': return actors.length > 1 && first === second ? `Two ${first === 'wild boar' ? 'wild boars' : `${first}s`} rested together` : `${an(first)} rested`;
      case 'moved': return failed ? `${an(first)} changed course` : `${an(first)} moved on`;
      case 'birth': case 'born': return `${an(first)} was born`;
      case 'immigration': return (event.conditions as Record<string, unknown> | undefined)?.route === 'island_crossing'
        ? `${an(first)} swam ashore onto the island` : `${an(first)} walked into the forest`;
      case 'death': return `${an(first)} died`;
      case 'died': {
        const cause = typeof (event.conditions as Record<string, unknown> | undefined)?.cause === 'string'
          ? (event.conditions as Record<string, string>).cause : '';
        return cause === 'predation' && second ? `${an(first)} was killed by ${an(second).toLowerCase()}` : `${an(first)} died`;
      }
      case 'fled': return `${an(first)} fled`;
      case 'courtship': return `${an(first)} courted a mate`;
      case 'wounded': return `${an(first)} was wounded`;
      case 'wound_healed': return `${an(first)}'s wound healed`;
      case 'disease_symptomatic': return `${an(first)} fell ill`;
      case 'disease_recovered': return `${an(first)} recovered from illness`;
      case 'disease_fatal': case 'wound_infection_fatal': return `${an(first)} did not survive its illness`;
      case 'life_stage': return `${an(first)} grew into its next life stage`;
      case 'dispersed': return `${an(first)} left to find a range of its own`;
      case 'parent_lost': return `A young ${first} lost its mother`;
      case 'skill_taught': return `${an(first)} taught a skill`;
      case 'tree_climbed': return `${an(first)} climbed a tree`;
      case 'illness_started': return `${an(first)} fell ill`;
      case 'illness_ended': return `${an(first)} recovered`;
      case 'human_task_finished': return 'A villager finished a task';
      case 'human_task_started': return 'A villager started a task';
      default: break;
    }
  }
  return feedEventSummary(event).title;
}

/** Only what has happened by the played time: the saved hour runs ahead of the screen. */
export function happenedBy<T extends Record<string, unknown>>(events: readonly T[], time: number | null): T[] {
  return time === null ? [...events] : events.filter((e) => typeof e.worldTime !== 'number' || e.worldTime <= time);
}

/**
 * Neighbouring events that read the same are shown once with a count, so one busy hour of
 * routine resting does not push every other event out of the feed.
 */
export function collapseFeed<T extends Record<string, unknown>>(events: readonly T[], limit: number): Array<{ event: T; sentence: string; count: number }> {
  const rows: Array<{ event: T; sentence: string; count: number }> = [];
  for (const event of events) {
    const sentence = feedSentence(event), last = rows.at(-1);
    if (last && last.sentence === sentence) { last.count++; continue; }
    if (rows.length === limit) break;
    rows.push({ event, sentence, count: 1 });
  }
  return rows;
}

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
  #passportHtml: string | undefined;
  #populationHtml = '';

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
        const response = await fetch(path + query, { signal: withTimeout(this.#recapAbort.signal, 15000) });
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

  /** The island's time as played on screen; falls back to the newest saved hour. */
  clockTime: () => number | null = () => this.store.world?.worldTime ?? null;
  /** What the followed animal is doing in the hour being played, when that is known. */
  liveActivity: (id: string) => { state: string; goal: string; agent?: string } | null = () => null;
  #clockText = '';

  constructor(private readonly elements: HudElements, private readonly store: WorldStore) {}

  /** Keeps the top-bar clock moving with the played hour; cheap enough for every frame. */
  tickClock(): void {
    const time = this.clockTime();
    const text = time === null ? '' : friendlyWorldTime(time);
    if (text === this.#clockText) return;
    this.#clockText = text;
    this.elements.clock.innerHTML = time === null ? UNKNOWN : escape(text);
  }

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
    this.#clockText = ''; this.tickClock();
    this.elements.clock.title = world?.formatted ?? '';
    this.elements.season.innerHTML = world ? escape(world.season.replace(/^./, (c) => c.toUpperCase())) : UNKNOWN;
    if (world) {
      const counts = Object.entries(world.population).sort((a, b) => b[1] - a[1]);
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      // Rebuilding the list would close it under the viewer's pointer; update only on change.
      const html = `<summary>${total.toLocaleString('en-IN')} animals</summary><div class="pop-list">${counts
        .map(([species, n]) => `<span>${escape(SPECIES_NAME[species] ?? species)} <b>${n}</b></span>`).join('')}</div>`;
      if (this.#populationHtml !== html) {
        const open = (this.elements.population.querySelector?.('details') as HTMLDetailsElement | null)?.open ?? false;
        this.elements.population.innerHTML = `<details${open ? ' open' : ''}>${html}</details>`;
        this.#populationHtml = html;
      }
    } else {
      this.elements.population.innerHTML = UNKNOWN;
      this.#populationHtml = '';
    }

    this.elements.notice.textContent = this.store.lastError ?? '';

    if (followedId === null) {
      this.#setPassport(
        '<p class="hint">Tap any animal to follow it, or pick a species above.</p>');
      return;
    }

    const animal = this.store.animals.get(followedId);
    const p = this.passport?.id === followedId ? this.passport : null;
    if (animal === undefined) {
      this.#setPassport(p?.death
        ? `<h2>${escape(p.id)}</h2><div class="sub">${escape(p.displayName)} &middot; died aged ${age(p.ageDays)}</div>
           <div class="row"><span>Cause</span><b>${escape(p.death.cause)}</b></div>
           <div class="row"><span>Record</span><b class="eid">${escape(p.death.eventId)}</b></div>
           ${this.#recapCard(followedId)}${this.#lineage(p)}
           <button data-history="${escape(p.id)}" aria-haspopup="dialog">Browse retained history</button>
           <button data-replay="${escape(p.id)}">Replay this life</button>
           ${this.shareButton(p.id)}`
        : `<p class="hint">${escape(followedId)} is no longer reported by the live simulation.</p>
           ${p ? `${this.#recapCard(followedId)}<button data-history="${escape(p.id)}" aria-haspopup="dialog">Browse retained history</button>
           <button data-replay="${escape(p.id)}">Replay this life</button>${this.shareButton(p.id)}` : ''}`);
      return;
    }

    const viewers = this.store.viewerCounts.get(followedId);
    const live = this.liveActivity(followedId);
    const identity = p === null
      ? `${animal.speciesId} &middot; patch ${animal.patchId}`
      : `${escape(p.sex)} &middot; ${escape(p.lifeStage)} &middot; ${age(p.ageDays)} &middot; generation ${p.generation}`;
    const name = p ? p.displayName : (SPECIES_NAME[animal.speciesId] ?? animal.speciesId).replace(/^./, (c) => c.toUpperCase());
    this.#setPassport(`${this.#recapCard(followedId)}
      <h2>${escape(name)}</h2>
      <div class="sub">${identity} &middot; ${escape(animal.id)}</div>
      ${bar('Hunger', animal.drives.hunger, 'var(--clay)')}
      ${bar('Thirst', animal.drives.thirst, 'var(--mist)')}
      ${bar('Fatigue', animal.drives.fatigue, 'var(--ink-3)')}
      ${bar('Fear', animal.drives.fear, 'var(--blood)')}
      <div class="row"><span>State</span><b>${escape(live?.state ?? animal.state)}</b></div>
      ${animal.illnessStatus === 'symptomatic'
        ? '<div class="row"><span>Health</span><b>Modelled illness symptoms</b></div>' : ''}
      ${animal.woundStatus
        ? `<div class="row"><span>Injury</span><b>Modelled ${animal.woundStatus === 'infected' ? 'wound infection' : 'open wound'}</b></div>` : ''}
      <div class="row"><span>Goal</span><b>${escape(live?.goal || animal.currentGoal)}</b></div>
      ${live?.agent ? `<div class="row"><span>Steered by</span><b class="agent-name">${escape(live.agent)} (AI agent)</b></div>` : ''}
      <div class="row"><span>Watching now</span><b>${viewers ?? UNKNOWN}</b></div>
      ${p === null ? '' : `<details class="story"><summary>Life story, family and skills</summary>${this.#skills(p) + this.#lineage(p) + this.#timeline(p)}</details>`}
      <div class="card-actions">
        <button data-replay="${escape(animal.id)}">Replay this life</button>
        <button data-history="${escape(animal.id)}" aria-haspopup="dialog">History</button>
        ${this.shareButton(animal.id)}
      </div>
      <details class="about"><summary>About this view</summary>
        <p class="prov">Model: ${escape(modelStatusForAnimal(animal))}.
        ${animal.position ? 'The server works the island out an hour at a time and this page plays each hour through as it happens, so the clock, light and feed follow what you see. Paths between points are drawn smoothly.' : 'Legacy patch-only data: within-patch placement is approximate.'} Visual coverage is asset metadata. Narration never changes outcomes.</p>
      </details>`);
  }

  /**
   * The page renders every second; rebuilding an unchanged card would close the section the
   * viewer opened and drop keyboard focus. Rebuild only on change, and restore both.
   */
  #setPassport(html: string): void {
    if (this.#passportHtml === html) return;
    const el = this.elements.passport;
    const open = new Set<string>();
    el.querySelectorAll?.('details[open]').forEach((d) => open.add(d.className));
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const focus = active && el.contains?.(active) ? focusSelector(active) : null;
    el.innerHTML = html;
    this.#passportHtml = html;
    el.querySelectorAll?.('details').forEach((d) => { if (open.has(d.className)) (d as HTMLDetailsElement).open = true; });
    if (focus) el.querySelector?.<HTMLElement>(focus)?.focus();
  }

  private shareButton(id: string): string {
    return `<button data-share="${escape(id)}" aria-haspopup="dialog">Share</button>`;
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
      const time = this.clockTime();
      const response = await fetch(`/api/events?limit=40${time === null ? '' : `&until=${Math.floor(time)}`}`);
      if (!response.ok) throw new Error('Event feed unavailable');
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      if (!Array.isArray(body.events)) throw new Error('Invalid event feed');
      // Newest few that have happened by the played clock, in plain words; the factual
      // label and record ID stay one tap away. Later ones appear as the hour plays on.
      this.elements.feed.innerHTML = collapseFeed(happenedBy(body.events, time), 6)
        .map(({ event, sentence, count }) => {
          const item = feedEventSummary(event);
          const when = typeof event.worldTime === 'number' ? friendlyWorldTime(event.worldTime).replace(/^Year \d+ · /, '') : '';
          return `<div class="event feed-entry"><div>
            <div class="etype">${escape(sentence)}${count > 1 ? ` <span class="feed-count">×${count}</span>` : ''}</div>
            <div class="feed-meta">${escape(when)}
              <details class="feed-provenance"><summary>Record ID</summary>${escape(item.title)} · ${escape(item.meta)} · <code>${escape(item.id)}</code></details>
            </div>
          </div></div>`;
        })
        .join('');
    } catch {
      this.elements.feed.innerHTML = '<p class="hint">event feed unavailable</p>';
    }
  }
}

/** A selector that finds the same control again after its card is rebuilt. */
function focusSelector(node: Element): string | null {
  for (const attr of ['data-replay', 'data-history', 'data-share', 'data-follow']) {
    const value = node.getAttribute(attr);
    if (value !== null) return `[${attr}="${CSS.escape(value)}"]`;
  }
  const section = node.tagName === 'SUMMARY' ? node.parentElement?.classList[0] : undefined;
  return section ? `details.${CSS.escape(section)} > summary` : null;
}
