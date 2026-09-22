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

export interface HudElements {
  clock: HTMLElement;
  season: HTMLElement;
  population: HTMLElement;
  passport: HTMLElement;
  feed: HTMLElement;
  notice: HTMLElement;
}

export class Hud {
  constructor(private readonly elements: HudElements, private readonly store: WorldStore) {}

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
    if (animal === undefined) {
      this.elements.passport.innerHTML =
        `<p class="hint">${followedId} is no longer reported by the simulation.</p>`;
      return;
    }

    const viewers = this.store.viewerCounts.get(followedId);
    this.elements.passport.innerHTML = `
      <h2>${animal.id}</h2>
      <div class="sub">${animal.speciesId} &middot; patch ${animal.patchId}</div>
      ${bar('Hunger', animal.drives.hunger, 'var(--clay)')}
      ${bar('Thirst', animal.drives.thirst, 'var(--mist)')}
      ${bar('Fatigue', animal.drives.fatigue, 'var(--ink-3)')}
      ${bar('Fear', animal.drives.fear, 'var(--blood)')}
      <div class="row"><span>State</span><b>${animal.state}</b></div>
      <div class="row"><span>Goal</span><b>${animal.currentGoal}</b></div>
      <div class="row"><span>Watching now</span><b>${viewers ?? UNKNOWN}</b></div>
      <p class="prov">every value above came from the simulation &middot; no model wrote this</p>`;
  }

  async refreshFeed(): Promise<void> {
    try {
      const response = await fetch('/api/events?limit=12');
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      this.elements.feed.innerHTML = body.events
        .map((event) => `<div class="event">
            <div class="etype">${String(event.type)}</div>
            <div class="eid">${String(event.id)}</div>
          </div>`)
        .join('');
    } catch {
      this.elements.feed.innerHTML = '<p class="hint">event feed unavailable</p>';
    }
  }
}
