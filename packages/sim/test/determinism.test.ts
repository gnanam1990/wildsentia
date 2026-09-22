import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/world.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('determinism guard', () => {
  it('never calls Math.random in the sim package', () => {
    expect(walk(SRC).filter((f) => readFileSync(f, 'utf8').includes('Math.random'))).toEqual([]);
  });

  it('contains no network or model client imports in the sim package', () => {
    const banned = ['openai', 'node-fetch', 'axios', 'undici', "from 'https'", "from 'http'"];
    expect(walk(SRC).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return banned.some((b) => src.includes(b));
    })).toEqual([]);
  });

  it('replays an identical event stream for a fixed seed', () => {
    const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
    const options = { seed: 1234, speciesDir, initialAgents: { sambar: 25 }, minPopulation: { sambar: 25 } };

    const a = createWorld(options);
    const b = createWorld(options);
    for (let h = 0; h < 500; h++) { a.step(1); b.step(1); }

    const fingerprint = (w: ReturnType<typeof createWorld>): string =>
      w.log.all().map((e) => `${e.id}|${e.type}|${e.worldTime}|${e.patchId}|${e.actors.join(',')}`).join('\n');

    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});
