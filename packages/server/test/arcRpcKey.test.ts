import { inspect } from 'node:util';
import { createPublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { redactUrl, rpcTransport } from '../src/arcBounties/chain.js';

// A managed RPC's key rides in its URL; the server logs the transport's errors whole.
const KEY = 'k3yInThePath_DoNotLog';

describe('the bounty RPC transport', () => {
  it('never writes a key-bearing URL into an error, alone or among fallbacks', async () => {
    for (const rpc of [`http://127.0.0.1:9/v2/${KEY}`, `http://127.0.0.1:9/v2/${KEY}, http://127.0.0.1:9/other/${KEY}2`]) {
      const client = createPublicClient({ transport: rpcTransport(rpc) });
      const error = await client.getBlockNumber().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const printed = `${inspect(error, { depth: 10 })} ${(error as Error).stack} ${String(error)}`;
      expect(printed).not.toContain(KEY);
      expect(printed).toContain('127.0.0.1:9/…');
    }
  });

  it('rewrites the message, the stack, the lists and the causes', () => {
    const url = `https://arc.example/v2/${KEY}`;
    const cause = Object.assign(new Error(`fetch ${url} failed`), { url });
    const error = Object.assign(new Error(`HTTP request failed.\nURL: ${url}`, { cause }), { metaMessages: [`URL: ${url}`], details: url });
    redactUrl(error, url, 'https://arc.example/…');
    expect(inspect(error, { depth: 10 })).not.toContain(KEY);
    expect(error.message).toBe('HTTP request failed.\nURL: https://arc.example/…');
  });
});
