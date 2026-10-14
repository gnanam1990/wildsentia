import type { LeagueWorld } from '@vana/shared';

/** The page's world-specific words: the island's, or the Congo forest's. */
export interface WorldWords {
  eyebrow: string; labTitle: string; changed: string; welcome: string;
  showMe: string; meet: string; meetQuestion: string; placeholder: string;
  seed: string; story: string;
}
const WORDS: Record<LeagueWorld, WorldWords> = {
  island: {
    eyebrow: 'One island. A thousand stories.', labTitle: 'What if the island changed?', changed: 'Changed island',
    welcome: 'Welcome to the island. Ask about an animal or let me show you a saved forest moment.',
    showMe: 'Show me a tiger', meet: 'Meet an elephant', meetQuestion: 'Tell me about an elephant', placeholder: 'Why is that tiger resting?',
    seed: 'Island seed', story: 'The island continues its own story.',
  },
  congo: {
    eyebrow: 'One forest. A thousand stories.', labTitle: 'What if the forest changed?', changed: 'Changed forest',
    welcome: 'Welcome to the forest. Ask about an animal or let me show you a saved forest moment.',
    showMe: 'Show me a leopard', meet: 'Meet a forest buffalo', meetQuestion: 'Tell me about a forest buffalo', placeholder: 'Why is that leopard resting?',
    seed: 'Forest seed', story: 'The forest continues its own story.',
  },
};
export function worldWords(world: LeagueWorld): WorldWords {
  return WORDS[world];
}

const NAMES: Record<string, string> = {
  tiger: 'Tiger', leopard: 'Leopard', chital: 'Chital', hare: 'Hare',
  african_leopard: 'African leopard', african_golden_cat: 'African golden cat', blue_duiker: 'Blue duiker', red_river_hog: 'Red river hog',
};
/** A league animal's name in the species list. */
export function leagueOptionLabel(choice: { id: string; hunts: boolean }): string {
  return NAMES[choice.id] ?? choice.id.replaceAll('_', ' ');
}
