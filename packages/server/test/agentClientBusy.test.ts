import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1A.3 review: a command refused with world_busy (the world was stepping) must not be lost.
let home: string, previousHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'vana-agent-'));
  previousHome = process.env.HOME;
  process.env.HOME = home; process.env.VANA_URL = 'http://wildsentia.test/api'; process.env.VANA_PROFILE = 'busy';
});
afterAll(() => { process.env.HOME = previousHome; rmSync(home, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('the agent client and a stepping world', () => {
  it('retries a command the server refused as world_busy, and gives up after three refusals', async () => {
    const replies = [
      { status: 503, body: { error: 'world_busy', retryAfterMs: 5 } },
      { status: 200, body: { ok: true } },
    ];
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/agents/info')) return Response.json({ audience: 'vana:w' });
      const next = replies.shift() ?? { status: 503, body: { error: 'world_busy', retryAfterMs: 5 } };
      return Response.json(next.body, { status: next.status });
    });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('../agent-client/client.mjs');
    await expect(api.release()).resolves.toEqual({ ok: true });
    const commandCalls = () => fetcher.mock.calls.filter(([u]) => String(u).endsWith('/agents/me/release')).length;
    expect(commandCalls()).toBe(2);
    await expect(api.release()).rejects.toThrow('world_busy');
    expect(commandCalls()).toBe(2 + 3);
  });
});
