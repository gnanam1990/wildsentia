import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Design §14.6, the honesty audit: every number and claim the UI shows must be traceable to live
 * state or an event, so authored prose asserting an animal's inner state ("she feels lonely", "he
 * misses his mother") is refused. A drive's reading from the server ("Hunger 26%") is traceable;
 * a sentence written into the page that claims a feeling is not. Exceptions are listed, reviewed.
 */
const FEELING = /\b(feels?|felt|griev(?:es|ing|ed)|mourn(?:s|ing|ed)?|misses|lonely|happy|sad|jealous|joyful|loves|hates|wonders|is (?:afraid|scared|angry|curious|bored|excited|proud|content|worried|anxious))\b/i;
/** Quoted strings on one line: what a page can show. */
const STRINGS = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
/** Reviewed exceptions: `file: string` pairs whose wording is not a claim about an animal. */
const ALLOWED = new Set<string>([]);

export function claims(source: string): string[] {
  const out: string[] = [];
  for (const m of source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').matchAll(STRINGS)) if (FEELING.test(m[0])) out.push(m[0]);
  return out;
}

describe('the honesty audit (design §14.6)', () => {
  it('catches authored prose claiming an animal\'s feelings, and leaves plain readings alone', () => {
    expect(claims("label.textContent = 'The doe feels lonely without her calf.';")).toHaveLength(1);
    expect(claims('const t = `${name} is afraid of the river`;')).toHaveLength(1);
    expect(claims("// a comment that says he misses her\nconst x = 'Hunger 26%';")).toEqual([]);
    expect(claims("headers: { 'Content-Type': 'application/json' }")).toEqual([]);
  });
  it('finds none in the client\'s pages and scripts, or the server\'s narration and experiences', () => {
    const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
    const list = (rel: string, ext: string) => readdirSync(dir(rel)).filter((f) => f.endsWith(ext)).map((f) => dir(rel) + f);
    const files = [...list('../src/', '.ts'), ...list('../', '.html'),
      ...list('../../server/src/narration/', '.ts'), ...list('../../server/src/experiences/', '.ts')];
    const found = files.flatMap((f) => claims(readFileSync(f, 'utf8')).map((s) => `${f.split('/').at(-1)}: ${s}`))
      .filter((hit) => !ALLOWED.has(hit));
    expect(found).toEqual([]);
  });
});
