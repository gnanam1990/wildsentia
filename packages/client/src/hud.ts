import type { WorldStore } from './protocol.js';

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
  recap: { id: string; days: number; lines: Array<{ eventId: string; text: string; narrated?: boolean }> } | null = null;

  async loadRecap(id: string, since: number, now: number): Promise<void> {
    try {
      const response = await fetch(`/api/animals/${encodeURIComponent(id)}/recap?since=${since}`);
      if (!response.ok) return;
      const body = (await response.json()) as { lines: Array<{ eventId: string; text: string; narrated?: boolean }> };
      this.recap = { id, days: (now - since) / 86_400, lines: body.lines };
    } catch {
      this.recap = null;
    }
  }

  constructor(private readonly elements: HudElements, private readonly store: WorldStore) {}

  async refreshPassport(id: string | null): Promise<void> {
    if (id === null) { this.passport = null; return; }
    try {
      const response = await fetch(`/api/animals/${encodeURIComponent(id)}/passport`);
      this.passport = response.ok ? (await response.json()) as Passport : null;
    } catch {
      this.passport = null;
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
           ${this.#lineage(p)}`
        : `<p class="hint">${escape(followedId)} is no longer reported by the simulation.</p>`;
      return;
    }

    const viewers = this.store.viewerCounts.get(followedId);
    const identity = p === null
      ? `${animal.speciesId} &middot; patch ${animal.patchId}`
      : `${escape(p.displayName)} &middot; ${escape(p.sex)} &middot; ${escape(p.lifeStage)} &middot; ${age(p.ageDays)} &middot; generation ${p.generation}`;
    this.elements.passport.innerHTML = `${this.#recapCard(followedId)}
      <h2>${animal.id}</h2>
      <div class="sub">${identity}</div>
      ${bar('Hunger', animal.drives.hunger, 'var(--clay)')}
      ${bar('Thirst', animal.drives.thirst, 'var(--mist)')}
      ${bar('Fatigue', animal.drives.fatigue, 'var(--ink-3)')}
      ${bar('Fear', animal.drives.fear, 'var(--blood)')}
      <div class="row"><span>State</span><b>${animal.state}</b></div>
      <div class="row"><span>Goal</span><b>${animal.currentGoal}</b></div>
      <div class="row"><span>Watching now</span><b>${viewers ?? UNKNOWN}</b></div>
      ${p === null ? '' : this.#skills(p) + this.#lineage(p) + this.#timeline(p)}
      <button data-replay="${escape(animal.id)}">Replay this life</button>
      <p class="prov">every value above came from the simulation &middot; no model wrote this</p>`;
  }

  #recapCard(id: string): string {
    const r = this.recap;
    if (r === null || r.id !== id) return '';
    const away = r.days >= 1 ? `${r.days.toFixed(1)} world days` : `${Math.round(r.days * 24)} world hours`;
    const body = r.lines.length === 0
      ? '<p class="hint">Nothing out of the ordinary: it ate, drank, rested and moved.</p>'
      : r.lines.slice(-12).map((l) => `<div class="event${l.narrated === true ? ' narrated' : ''}"
          ${l.narrated === true ? 'title="Reworded by a model from this event, and checked to name the same animals and numbers"' : ''}>
          <div class="etype">${escape(l.text)}</div><div class="eid">${escape(l.eventId)}</div></div>`).join('');
    const reworded = r.lines.some((l) => l.narrated === true);
    return `<section class="recap"><h3>While you were away &middot; ${away}</h3>${body}
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
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      this.elements.feed.innerHTML = body.events
        .map((event) => `<div class="event">
            <div class="etype">${escape(String(event.type))}</div>
            <div class="eid">${escape(String(event.id))}</div>
          </div>`)
        .join('');
    } catch {
      this.elements.feed.innerHTML = '<p class="hint">event feed unavailable</p>';
    }
  }
}
