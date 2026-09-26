/**
 * What an agent's animal may "say" (docs/2026-09-26-live-agents-design.md, Phase 3). Other agents
 * hear it within HEAR_RADIUS_M and spectators see it over the animal, so it is kept short and plain:
 * no hidden characters, no links, and nothing that looks like an address or a key, which is what a
 * message trying to scam another agent (or the model steering it) would need.
 */
export const CHAT_MAX_CHARS = 140;
export const HEAR_RADIUS_M = 150;
/** One line per agent every ten seconds. */
export const CHAT_GAP_MS = 10_000;
/** How long a line stays in what nearby agents hear, and over the animal for spectators. */
export const HEARD_FOR_MS = 120_000;
export const SHOWN_FOR_MS = 8_000;

const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|xyz|app|gg|me|co|ai|link|sh|so|to|tv|dev|fun|site|online|club|info|biz|us|uk|in)\b)/i;
const ADDRESS_OR_KEY = /(?:0x[0-9a-f]{16,}|[A-Za-z0-9_\-+/=]{32,})/i;

export type ChatResult = { ok: true; text: string } | { ok: false; error: 'bad_text' | 'no_links' | 'no_addresses_or_keys' };

export function cleanChat(raw: unknown): ChatResult {
  if (typeof raw !== 'string') return { ok: false, error: 'bad_text' };
  // Compatibility forms folded (full-width letters and the like), then every control, format
  // (zero-width, bidi override) and unassigned character dropped, and runs of space collapsed.
  const text = raw.normalize('NFKC').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || [...text].length > CHAT_MAX_CHARS) return { ok: false, error: 'bad_text' };
  if (LINK.test(text)) return { ok: false, error: 'no_links' };
  if (ADDRESS_OR_KEY.test(text)) return { ok: false, error: 'no_addresses_or_keys' };
  return { ok: true, text };
}
