import type { WorldStore } from './protocol.js';
import { withTimeout } from './abortSignals.js';
import { modelStatusForAnimal } from './species.js';
import { validNextCursor } from './historyCursor.js';
import { friendlyWorldTime } from './worldTime.js';
export { friendlyWorldTime };
import { PASSPORT_TABS, PassportTabs, type PassportTab } from './passportTabs.js';

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

/** A count from the server, grouped in thousands; anything that is not a number shows as unknown. */
const count = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : UNKNOWN;

const age = (days: number): string =>
  days >= 365 ? `${(days / 365).toFixed(1)} years` : `${Math.round(days)} days`;

const readable = (value: string): string => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

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

const SPECIES_NAME: Record<string, string> = {
  chital: 'chital', sambar: 'sambar', gaur: 'gaur', dhole: 'dhole', jackal: 'jackal', boar: 'wild boar',
  tiger: 'tiger', leopard: 'leopard', elephant: 'elephant', langur: 'langur', squirrel: 'giant squirrel', hare: 'hare', vulture: 'vulture',
  human: 'villager',
  african_leopard: 'African leopard', blue_duiker: 'blue duiker', water_chevrotain: 'water chevrotain',
  bay_duiker: 'bay duiker', peters_duiker: 'Peters\'s duiker', red_river_hog: 'red river hog', forest_buffalo: 'forest buffalo',
  sitatunga: 'sitatunga', african_golden_cat: 'African golden cat',
  forest_elephant: 'forest elephant', agile_mangabey: 'agile mangabey', crowned_eagle: 'crowned eagle', dwarf_crocodile: 'dwarf crocodile',
};
const speciesOf = (id: string | undefined): string | null => {
  if (!id) return null;
  // An id is the species and a serial (`blue_duiker_00ab`); people are `person_…`.
  const last = id.lastIndexOf('_'), prefix = id.split('_')[0] ?? '';
  return (last > 0 ? SPECIES_NAME[id.slice(0, last)] : undefined) ?? SPECIES_NAME[prefix] ?? null;
};
const an = (noun: string) => (/^[aeiou]/i.test(noun) ? `An ${noun}` : `A ${noun}`);
/** The same in the middle of a sentence: only the article is lower case ("a Peters's duiker", "an African leopard"). */
const aOr = (noun: string) => (/^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`);

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
      case 'hunt': return second ? (outcome === 'success' ? `${an(first)} caught ${aOr(second)}` : `${an(first)}'s hunt for ${aOr(second)} failed`) : `${an(first)} hunted`;
      case 'human_hunt': return outcome === 'success' ? 'Villagers brought back a catch' : 'A village hunt came back empty';
      case 'scavenged': return second ? `${an(first)} fed on ${aOr(second)} carcass` : `${an(first)} scavenged`;
      case 'fed': return ['tiger', 'leopard', 'dhole', 'jackal', 'African leopard', 'African golden cat'].includes(first) ? `${an(first)} ate`
        : ['wild boar', 'red river hog'].includes(first) ? `${an(first)} foraged` : `${an(first)} grazed`;
      case 'drank': return `${an(first)} drank water`;
      case 'rested': return actors.length > 1 && first === second ? `Two ${first === 'wild boar' ? 'wild boars' : `${first}s`} rested together` : `${an(first)} rested`;
      case 'moved': return failed ? `${an(first)} changed course` : `${an(first)} moved to new ground`;
      case 'birth': case 'born': return `${an(first)} was born`;
      case 'immigration': return (event.conditions as Record<string, unknown> | undefined)?.route === 'island_crossing'
        ? `${an(first)} swam ashore onto the island` : `${an(first)} walked into the forest`;
      case 'death': return `${an(first)} died`;
      case 'died': {
        const cause = typeof (event.conditions as Record<string, unknown> | undefined)?.cause === 'string'
          ? (event.conditions as Record<string, string>).cause : '';
        return cause === 'predation' && second ? `${an(first)} was killed by ${aOr(second)}` : `${an(first)} died`;
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

/** Everyday events the feed leaves out: every animal moves, rests, eats and drinks all the time. */
export const ROUTINE_EVENTS = new Set(['moved', 'rested', 'fed', 'drank']);

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

export interface FeedGroup {
  sentence: string;
  events: Array<Record<string, unknown>>;
}

/** Group the existing six-event window without changing its newest-first order or its facts.
 * An unknown time cannot establish a shared hour, so those records stay separate. */
export function groupFeedEvents(events: readonly Record<string, unknown>[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const byHourAndSentence = new Map<string, FeedGroup>();
  for (const event of events.slice(0, 6)) {
    const sentence = feedSentence(event);
    const hour = typeof event.worldTime === 'number' && Number.isFinite(event.worldTime) && event.worldTime >= 0
      ? Math.floor(event.worldTime / 3600) : null;
    const key = hour === null ? null : JSON.stringify([hour, sentence]);
    const existing = key === null ? undefined : byHourAndSentence.get(key);
    if (existing) existing.events.push(event);
    else {
      const group = { sentence, events: [event] };
      groups.push(group);
      if (key !== null) byHourAndSentence.set(key, group);
    }
  }
  return groups;
}

const kinLink = (kin: { id: string; alive: boolean } | null): string => kin === null
  ? '<span class="unknown" title="a founder or immigrant: no parent in the record">none recorded</span>'
  : `<a href="#" data-follow="${escape(kin.id)}" data-passport-focus="${escape(`kin:${kin.id}`)}">${escape(kin.id)}</a>${kin.alive ? '' : ' <i>(dead)</i>'}`;

export interface HudElements {
  clock: HTMLElement;
  season: HTMLElement;
  population: HTMLElement;
  renderPopulation?: (total: number | null, listHtml: string) => void;
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
  #feedHtml = '';
  #passportTabs: PassportTabs;

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

  /** The clock and activity follow the hour currently played on screen. */
  clockTime: () => number | null = () => this.store.world?.worldTime ?? null;
  liveActivity: (id: string) => { state: string; goal: string; agent?: string } | null = () => null;
  #clockText: string | null = null;

  constructor(private readonly elements: HudElements, private readonly store: WorldStore) {
    this.#passportTabs = new PassportTabs(elements.passport);
  }

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
    this.tickClock();
    this.elements.clock.title = world?.formatted ?? '';
    this.elements.season.innerHTML = world ? escape(world.season.replace(/^./, (c) => c.toUpperCase())) : UNKNOWN;
    if (world) {
      const counts = Object.entries(world.population as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
        .sort((a, b) => b[1] - a[1]);
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      const listHtml = counts.map(([species, n]) => `<span>${escape(SPECIES_NAME[species] ?? species)} <b>${count(n)}</b></span>`).join('');
      // Rebuilding the list would close it under the viewer's pointer; update only on change.
      const html = `<summary>${count(total)} animals</summary><div class="pop-list">${listHtml}</div>`;
      if (this.elements.renderPopulation) this.elements.renderPopulation(total, listHtml);
      else if (this.#populationHtml !== html) {
        const open = (this.elements.population.querySelector?.('details') as HTMLDetailsElement | null)?.open ?? false;
        this.elements.population.innerHTML = `<details${open ? ' open' : ''}>${html}</details>`;
        this.#populationHtml = html;
      }
    } else {
      this.#populationHtml = '';
      if (this.elements.renderPopulation) this.elements.renderPopulation(null, '');
      else this.elements.population.innerHTML = UNKNOWN;
    }

    const notice = this.store.errorNotice() ?? '';
    if (this.elements.notice.textContent !== notice) this.elements.notice.textContent = notice;

    if (followedId === null) {
      this.#passportTabs.render(null, '<div class="passport-empty"><p>Choose a life to follow</p><span>Tap an animal in the forest, or choose a species above.</span></div>');
      return;
    }

    const animal = this.store.animals.get(followedId);
    const p = this.passport?.id === followedId ? this.passport : null;
    const viewers = this.store.viewerCounts.get(followedId);
    const live = this.liveActivity(followedId);
    const identity = p
      ? `${escape(readable(p.sex))} &middot; ${p.death ? `died aged ${age(p.ageDays)}` : `${age(p.ageDays)} &middot; ${escape(readable(p.lifeStage))}`}`
      : [animal?.sex, animal?.lifeStage].filter((value): value is string => typeof value === 'string')
        .map(value => escape(readable(value))).join(' &middot; ') || 'Life details unavailable';
    const name = p?.displayName ?? readable(animal ? SPECIES_NAME[animal.speciesId] ?? animal.speciesId : speciesOf(followedId) ?? 'Animal');
    const state = animal ? readable(live?.state ?? animal.state) : p?.death ? 'Died' : 'Unavailable';
    const overview = animal
      ? `<div class="vitals" aria-label="Reported drives">
          ${bar('Hunger', animal.drives.hunger, 'var(--clay)')}
          ${bar('Thirst', animal.drives.thirst, 'var(--mist)')}
          ${bar('Fatigue', animal.drives.fatigue, 'var(--ink-3)')}
          ${bar('Fear', animal.drives.fear, 'var(--blood)')}
        </div>
        <div class="subject-activity"><div><span>Current goal</span><strong>${escape(readable(live?.goal || animal.currentGoal))}</strong></div>
          <div class="subject-watchers"><span>Watching now</span><strong>${count(viewers)}</strong></div></div>
        ${live?.agent ? `<p class="subject-agent">Steered by ${escape(live.agent)} (AI agent)</p>` : ''}
        ${animal.illnessStatus === 'symptomatic' || animal.woundStatus ? `<div class="subject-health">
          ${animal.illnessStatus === 'symptomatic' ? '<p>Modelled illness symptoms</p>' : ''}
          ${animal.woundStatus ? `<p>Modelled ${animal.woundStatus === 'infected' ? 'wound infection' : 'open wound'}</p>` : ''}</div>` : ''}`
      : `<p class="hint">${p?.death ? 'This life has ended. Its saved family and events remain in Life; death details are in Record.'
        : 'This animal is no longer reported by the live simulation.'}</p>`;
    const record = `<dl class="record-facts"><div><dt>Animal ID</dt><dd><code>${escape(followedId)}</code></dd></div>
      ${animal ? `<div><dt>Patch</dt><dd>${count(animal.patchId)}</dd></div>` : ''}
      ${p ? `<div><dt>Generation</dt><dd>${count(p.generation)}</dd></div>` : ''}
      ${p?.asOfWorldTime !== undefined ? `<div><dt>Saved at</dt><dd>${escape(friendlyWorldTime(p.asOfWorldTime))}</dd></div>` : ''}
      ${p?.death ? `<div><dt>Cause of death</dt><dd>${escape(readable(p.death.cause))}</dd></div>
        <div><dt>Died at</dt><dd>${escape(friendlyWorldTime(p.death.worldTime))}</dd></div>
        <div><dt>Death record</dt><dd><code>${escape(p.death.eventId)}</code></dd></div>` : ''}</dl>
      ${animal || p ? `<p class="prov">Model: ${escape(modelStatusForAnimal(animal ?? p!))}.</p>` : ''}
      <p class="prov">${animal ? animal.position ? 'Positions are recorded by the server; paths between updates are interpolated, not collision-aware.' : 'Legacy patch-only data: within-patch placement is approximate.'
        : 'This view uses the saved life record when available.'} Visual coverage is asset metadata. Narration never changes outcomes.</p>`;
    const panels: Record<PassportTab, string> = {
      overview: overview + this.#recapCard(followedId),
      life: p ? this.#skills(p) + this.#lineage(p) + this.#timeline(p)
        : '<p class="hint">Life history is unavailable right now. The saved record will appear here when it is available.</p>',
      record,
    };
    this.#passportTabs.render(followedId, `<header class="subject-heading"><div class="subject-title-row">
      <h2>${escape(name)}</h2></div>
      <div class="subject-meta">${identity} &middot; <span class="subject-state" aria-label="State: ${escape(state)}">${escape(state)}</span></div></header>
      <div class="passport-tabs" role="tablist" aria-label="Animal information">${PASSPORT_TABS.map(tab => `
        <button type="button" role="tab" id="passport-tab-${tab}" aria-controls="passport-panel-${tab}"
          aria-selected="${tab === 'overview'}" tabindex="${tab === 'overview' ? '0' : '-1'}" data-passport-tab="${tab}"
          data-passport-focus="tab:${tab}">${readable(tab)}</button>`).join('')}</div>
      <div class="passport-panels">${PASSPORT_TABS.map(tab => `<section class="passport-panel${tab === 'record' ? ' passport-record' : ''}"
        role="tabpanel" id="passport-panel-${tab}" aria-labelledby="passport-tab-${tab}" tabindex="0" data-passport-panel="${tab}"
        data-passport-focus="panel:${tab}"${tab === 'overview' ? '' : ' hidden'}>${panels[tab]}</section>`).join('')}</div>
      ${animal || p ? `<footer class="card-actions">
        <button type="button" data-replay="${escape(followedId)}" data-passport-focus="replay">Replay life</button>
        <button type="button" data-history="${escape(followedId)}" data-passport-focus="history" aria-haspopup="dialog">History</button>
        ${this.shareButton(followedId)}</footer>` : ''}`);
  }

  private shareButton(id: string): string {
    return `<button type="button" data-share="${escape(id)}" data-passport-focus="share" aria-haspopup="dialog">Share</button>`;
  }

  #recapCard(id: string): string {
    if (this.recapStatus?.id === id) return `<p role="status">${escape(this.recapStatus.text)}</p>`;
    const r = this.recap;
    if (r === null || r.id !== id || r.lines.length === 0) return '';
    const away = r.days >= 1 ? `${r.days.toFixed(1)} world days` : `${Math.round(r.days * 24)} world hours`;
    const body = r.lines.slice(-12).map((l) => `<div class="event${l.narrated === true ? ' narrated' : ''}"
          ${l.narrated === true ? 'title="The event fact clause is unchanged; only a neutral prefix is allowed"' : ''}>
          <div class="etype">${escape(l.text)}</div><div class="eid">${escape(l.eventId)}</div></div>`).join('');
    const reworded = r.lines.some((l) => l.narrated === true);
    return `<section class="recap"><h3>While you were away &middot; ${away}</h3>${body}
      ${r.totalLines > 12 ? `<p class="prov">Latest 12 of ${r.totalLines} summary lines. Use Browse retained history for the event records.</p>` : ''}
      ${reworded ? '<p class="prov">lines marked &#9998; were reworded by a model from the event shown beside them</p>' : ''}
      <button data-dismiss-recap data-passport-focus="recap-dismiss">Got it</button></section>`;
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
      <div class="row"><span>Young</span><b>${count(p.lineage.offspring.length)} (${count(living)} alive)</b></div>`;
  }

  #timeline(p: Passport): string {
    if (p.timeline.length === 0) return '';
    return `<h3>Life so far</h3><div class="timeline">${p.timeline.slice(0, 12).map((e) => `
      <div class="event"><div class="etype">${escape(e.type)} <i>${escape(e.outcome)}</i></div>
      <div class="eid">${escape(e.id)}</div></div>`).join('')}</div>`;
  }

  #renderFeed(html: string): void {
    // Identical polls should preserve focus, selection, disclosure state and scroll.
    if (html === this.#feedHtml) return;
    const opened = new Set(Array.from(this.elements.feed.querySelectorAll?.<HTMLDetailsElement>('details[data-feed-group][open]') ?? [])
      .map(detail => detail.dataset.feedGroup));
    this.elements.feed.innerHTML = html;
    for (const detail of this.elements.feed.querySelectorAll?.<HTMLDetailsElement>('details[data-feed-group]') ?? []) {
      if (opened.has(detail.dataset.feedGroup)) detail.open = true;
    }
    this.#feedHtml = html;
  }

  async refreshFeed(): Promise<void> {
    try {
      const time = this.clockTime();
      // News only (hunts, births, deaths, arrivals, illness): thousands of animals moving and resting would bury it.
      const response = await fetch(`/api/events?limit=40${time === null ? '' : `&until=${Math.floor(time)}&notable=1`}`);
      if (!response.ok) throw new Error('Event feed unavailable');
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      if (!Array.isArray(body.events)) throw new Error('Invalid event feed');
      const news = happenedBy(body.events.filter(event => !ROUTINE_EVENTS.has(String(event.type))), time);
      if (news.length === 0) {
        this.#renderFeed(body.events.length === 0
          ? '<p class="hint">No recorded events yet. New activity will appear here.</p>'
          : '<p class="hint">Quiet for now. Hunts, births and deaths appear as they happen in the played hour.</p>');
        return;
      }
      // Newest few, in plain words; the factual label and record ID stay one tap away.
      const html = groupFeedEvents(news)
        .map((group) => {
          const event = group.events[0]!;
          const key = JSON.stringify(group.events.map(record => typeof record.id === 'string' ? record.id
            : [group.sentence, record.worldTime ?? null]));
          const when = typeof event.worldTime === 'number' ? friendlyWorldTime(event.worldTime).replace(/^Year \d+ · /, '') : '';
          const records = group.events.map(record => {
            const item = feedEventSummary(record);
            return `<div class="feed-record">${escape(item.title)} · ${escape(item.meta)} · <code>${escape(item.id)}</code></div>`;
          }).join('');
          return `<div class="event feed-entry"><div>
            <div class="etype">${escape(group.sentence)}</div>
            <div class="feed-meta">${escape(when)}
              ${group.events.length > 1 ? `<span class="feed-count">${group.events.length} recorded events</span>` : ''}
              <details class="feed-provenance" data-feed-group="${escape(key)}"><summary>${group.events.length > 1 ? 'Record IDs' : 'Record ID'}</summary>${records}</details>
            </div>
          </div></div>`;
        })
        .join('');
      this.#renderFeed(html);
    } catch {
      this.#renderFeed('<p class="hint">event feed unavailable</p>');
    }
  }
}
