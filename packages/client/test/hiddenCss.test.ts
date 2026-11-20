import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pages = ['index.html', 'connect.html', 'rewards-admin.html', 'social-admin.html', 'characters.html'];

describe('hidden attribute', () => {
  // The agents list once stayed open over the top bar: its `display: grid` beat `hidden`.
  it('always wins over component display rules on every page', () => {
    for (const page of pages) {
      const sheets = [...read(page).matchAll(/href="\/src\/([a-zA-Z]+\.css)"/g)].map((m) => m[1]!);
      expect(sheets.length, page).toBeGreaterThan(0);
      expect(sheets.some((sheet) => /(^|\n)\[hidden\] \{ display: none !important; \}/.test(read(`src/${sheet}`))), page).toBe(true);
    }
  });
});
