import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { xIntent, type PublicBounty } from '../src/bountyBoardModel.js';
import { featureOn } from '../src/pageChrome.js';
import { WELCOME_SEEN_KEY, shouldWelcome, welcomeWords } from '../src/welcomeCard.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const live = (amountAtomic: string): PublicBounty => ({ bountyId: '0x1', status: 'active', speciesId: 'blue_duiker', region: 'r1_1', amountAtomic,
  timeLeftWorldSeconds: 3600, publishTxUrl: null });

describe('a first visit', () => {
  it('is told what the forest is, and what is live only when a bounty is', () => {
    const quiet = welcomeWords([]);
    expect(quiet.body).toMatch(/AI agents can take one over/);
    expect(quiet.live).toBeNull();
    expect(welcomeWords(null).live).toBeNull();
    const now = welcomeWords([live('1500000'), { ...live('1000000'), bountyId: '0x2', status: 'paid', outcome: 'void', targetAnimalId: 'blue_duiker_0207' }]);
    expect(now.live).toBe('Now: 1 bounty live · 1.5 USDC. Which animal is it? Nobody is told.');
    // The welcome never names the animal a bounty is on.
    expect(JSON.stringify(now)).not.toContain('0207');
  });

  it('is welcomed once, never inside an embed, and still when storage is blocked', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    expect(shouldWelcome(storage, '')).toBe(true);
    store.set(WELCOME_SEEN_KEY, '1');
    expect(shouldWelcome(storage, '')).toBe(false);
    expect(shouldWelcome(null, '?embed=experiences')).toBe(false);
    expect(shouldWelcome({ getItem: () => { throw new Error('blocked'); } }, '')).toBe(true);
  });

  it('offers the bounty board and connecting an agent once the veil lifts', () => {
    const main = read('src/main.ts');
    expect(main).toMatch(/new WelcomeCard\(\{ openBounties: \(\) => bountyForest\.open\(\) \}/);
    expect(main).toMatch(/veil\.frameDrawn\(\);\n\s*if \(veil\.lifted\) void welcome\.show\(\);/);
    const card = read('src/welcomeCard.ts');
    expect(card).toContain("agent.href = '/connect.html#quick-start'");
    expect(card).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});

describe('sharing', () => {
  it('opens X with the post written and the link attached', () => {
    const url = new URL(xIntent('Hunter won 1.5 USDC', 'https://wildsentia.lol/api/share/bounty/0xab'));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe('Hunter won 1.5 USDC');
    expect(url.searchParams.get('url')).toBe('https://wildsentia.lol/api/share/bounty/0xab');
    expect(read('src/bountyBoard.ts')).toMatch(/postOnX\(b\), shareButton\(b\)\);[\s\S]*postOnX\(b\), shareButton\(b\)\);/);
  });

  it('gives every public page a large card with an absolute image, so a posted link shows a preview', () => {
    for (const page of ['index.html', 'bounties.html', 'connect.html', 'experiences.html']) {
      const html = read(page);
      expect(html, page).toMatch(/<meta property="og:image" content="https:\/\/wildsentia\.lol\/og\/[a-z-]+\.(png|jpg)" \/>/);
      expect(html, page).toMatch(/<meta name="twitter:image" content="https:\/\/wildsentia\.lol\/og\/[a-z-]+\.(png|jpg)" \/>/);
      expect(html, page).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(html, page).toMatch(/<meta name="description" content="[^"]{60,}" \/>/);
      expect(html, page).toContain('<link rel="icon" href="/favicon.ico"');
    }
  });
});

describe('public pages say what this forest is', () => {
  it('are written for the Congo forest, not the island, before any script runs', () => {
    for (const page of ['index.html', 'bounties.html', 'connect.html', 'experiences.html'])
      expect(read(page), page).not.toMatch(/\bisland\b|chital|sambar|tiger|dhole/i);
  });

  it('tell one payout story: bounties on Arc Testnet; drops only where this server pays them', () => {
    const connect = read('connect.html'), bounties = read('bounties.html');
    expect(connect).not.toMatch(/on Base/);
    expect(connect).toMatch(/<section class="holder-card" aria-labelledby="wallet-title" id="drops-card" hidden>/);
    expect(read('src/connect.ts')).toMatch(/fetch\('\/api\/rewards\/summary'[\s\S]{0,120}#drops-card'\)!\.hidden = !drops/);
    expect(bounties).toContain('<span class="net-badge">Arc Testnet</span>');
    expect(bounties).toContain('How a bounty is paid');
    // The pool is named for what it is, not for what pays into it.
    expect(bounties).not.toMatch(/Trades/);
  });

  it('send nobody to internal review pages from the forest settings', () => {
    const index = read('index.html');
    expect(index).not.toContain('href="/characters.html"');
    expect(index).not.toContain('href="/holder.html"');
  });

  it('keep the quick start the first path, with building your own folded below it', () => {
    const connect = read('connect.html');
    expect(connect).toContain('id="quick-start"');
    expect(connect.indexOf('id="quick-start"')).toBeLessThan(connect.indexOf('id="build-own"'));
    expect(connect).toMatch(/<details class="holder-card build-own" id="build-own">/);
  });
});

describe('the header places', () => {
  it('appear only where the server runs them', () => {
    expect([200, 401, 403].map(featureOn)).toEqual([true, true, true]);
    expect([404, 500, 503].map(featureOn)).toEqual([false, false, false]);
  });
});
