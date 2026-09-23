/** Animal and event ids as the simulation writes them: species, underscore, hex. */
const ID = /\b[a-z]+_[0-9a-f]{4,}\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;
/** A rephrasing is one sentence for a watcher, not a paragraph. */
const MAX_LENGTH = 220;

const set = (text: string, pattern: RegExp): Set<string> => new Set(text.match(pattern) ?? []);

/**
 * The grounding check on the one-way valve (spec §9.2). A model may change how a line reads,
 * never what it says: every animal the record names must still be named, no other animal may
 * appear, no number may appear that the record did not give, and it must stay a short line.
 * Anything that fails is discarded and the template is shown instead.
 */
export function isGrounded(template: string, rewrite: string): boolean {
  const text = rewrite.trim();
  if (text.length === 0 || text.length > MAX_LENGTH) return false;

  const wantIds = set(template, ID);
  const gotIds = set(text, ID);
  for (const id of wantIds) if (!gotIds.has(id)) return false;
  for (const id of gotIds) if (!wantIds.has(id)) return false;

  // Ids carry hex digits; compare numbers only outside them.
  const allowed = set(template.replace(ID, ''), NUMBER);
  for (const n of set(text.replace(ID, ''), NUMBER)) if (!allowed.has(n)) return false;
  return true;
}
