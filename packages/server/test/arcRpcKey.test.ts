import { inspect } from 'node:util';
import { createPublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { redactUrl, rpcTransport } from '../src/arcBounties/chain.js';
import { viemChallengeChain } from '../src/challenges/chain.js';

// A managed RPC's key rides in its URL; the server logs the transport's errors whole.
const KEY = 'k3yInThePath_DoNotLog';

describe('the bounty RPC transport', () => {
  it('never writes a key-bearing URL into an error, alone or among fallbacks', async () => {
    for (const rpc of [`http://127.0.0.1:9/v2/${KEY}`, `http://127.0.0.1:9/v2/${KEY}, http://127.0.0.1:9/other/${KEY}2`,
      // viem prints this one normalised, its credentials stripped: the exact URL never appears.
      `http://user:pa55word@127.0.0.1:9/v2/${KEY}`]) {
      const client = createPublicClient({ transport: rpcTransport(rpc) });
      const error = await client.getBlockNumber().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const printed = `${inspect(error, { depth: 10 })} ${(error as Error).stack} ${String(error)}`;
      expect(printed).not.toContain(KEY);
      expect(printed).not.toContain('pa55word');
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

  it('finds the URL in any form it is written: normalised, without credentials, or its path alone', () => {
    const url = `https://User:Secr3t@ARC.example/v2/${KEY}?x=1`;
    const error = new Error([`URL: https://arc.example/v2/${KEY}?x=1`, `as given ${url}`, `path /v2/${KEY}?x=1`, 'password Secr3t'].join('\n'));
    redactUrl(error, url, 'https://arc.example/…');
    expect(error.message).not.toMatch(new RegExp(`${KEY}|Secr3t`));
    expect(error.message).toContain('URL: https://arc.example/…');
  });

  it('keeps the key out of the Challenges client\'s errors too', async () => {
    const url = `https://127.0.0.1:9/v2/${KEY}`;
    const challenges = viemChallengeChain({ rpcUrl: url, chainId: 5042002, contract: `0x${'1'.repeat(40)}`, evaluatorKey: `0x${'2'.repeat(64)}` });
    for (const call of [() => challenges.head()]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(`${inspect(error, { depth: 10 })} ${(error as Error).stack}`).not.toContain(KEY);
    }
  });
});
