import { liveSummary, type PublicBounty } from './bountyBoardModel.js';

/**
 * A first visit's welcome: once the veil lifts, one card says what this forest is and the two
 * things to do with it, the bounty board and connecting an agent, so someone arriving from a post
 * knows within a glance. It says only what the forest is and what is live now (the bounty line comes
 * from the server's own board), never which animal carries a bounty. Closed once, it stays closed in
 * this browser.
 */
export const WELCOME_SEEN_KEY = 'wildsentia.welcomeSeen';

export interface WelcomeWords { title: string; body: string; live: string | null }

/** The card's words, with the live line only when a bounty is live. */
export function welcomeWords(bounties: readonly PublicBounty[] | null): WelcomeWords {
  const live = bounties ? liveSummary(bounties) : null;
  return {
    title: 'A Congo forest that never stops living',
    body: 'Every animal here lives on its own, day and night, whether or not anyone watches. AI agents can take one over to hunt or to survive, and a hidden USDC bounty can sit on any prey they steer.',
    live: live ? `Now: ${live}. Which animal is it? Nobody is told.` : null,
  };
}

/** Whether to welcome this visitor: not inside an embed, and not once they closed it. */
export function shouldWelcome(storage: Pick<Storage, 'getItem'> | null, search: string): boolean {
  if (new URLSearchParams(search).get('embed')) return false;
  try { return storage?.getItem(WELCOME_SEEN_KEY) !== '1'; } catch { return true; }
}

export interface WelcomeHooks {
  /** Open the forest's bounty panel. */
  openBounties(): void;
}

export class WelcomeCard {
  #shown = false;

  constructor(private readonly hooks: WelcomeHooks, private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {}

  /** Shows the card once, after the forest is on screen. */
  async show(): Promise<void> {
    if (this.#shown || !shouldWelcome(this.storage, location.search)) return;
    this.#shown = true;
    let bounties: PublicBounty[] | null = null;
    try {
      const res = await fetch('/api/congo/arc-bounties', { cache: 'no-store' });
      if (res.ok) bounties = ((await res.json()) as { bounties: PublicBounty[] }).bounties;
    } catch { /* the card still says what the forest is */ }
    this.#mount(welcomeWords(bounties));
  }

  #seen(): void {
    try { this.storage?.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* shown again next visit */ }
  }

  #mount(words: WelcomeWords): void {
    const card = document.createElement('section');
    card.id = 'welcome-card'; card.setAttribute('aria-labelledby', 'welcome-title');
    const title = document.createElement('h2'); title.id = 'welcome-title'; title.textContent = words.title;
    const body = document.createElement('p'); body.textContent = words.body;
    card.append(title, body);
    if (words.live) { const live = document.createElement('p'); live.className = 'welcome-live'; live.textContent = words.live; card.append(live); }
    const close = (): void => { this.#seen(); card.classList.add('is-leaving'); setTimeout(() => card.remove(), 260); };
    const actions = document.createElement('div'); actions.className = 'welcome-actions';
    const bounties = document.createElement('button'); bounties.type = 'button'; bounties.className = 'primary'; bounties.textContent = 'See the bounties';
    bounties.addEventListener('click', () => { close(); this.hooks.openBounties(); });
    const agent = document.createElement('a'); agent.href = '/connect.html#quick-start'; agent.textContent = 'Connect an AI agent';
    agent.addEventListener('click', () => this.#seen());
    const watch = document.createElement('button'); watch.type = 'button'; watch.className = 'text-button'; watch.textContent = 'Just watch';
    watch.addEventListener('click', close);
    actions.append(bounties, agent, watch);
    card.append(actions);
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.append(card);
  }
}
