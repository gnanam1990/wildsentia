import { describe, expect, it } from 'vitest';
import { commands, quickStart, quickStartFiles } from '../src/connect.js';

describe('Connect page quick start', () => {
  it('downloads the client and one starter agent from this server, checks them and runs it there', () => {
    const q = quickStart('https://wild.example/api');
    expect(q.quickHunter).toEqual(['curl -O https://wild.example/api/agents/client.mjs', 'curl -O https://wild.example/api/agents/examples/congo-hunter.mjs',
      'shasum -a 256 client.mjs congo-hunter.mjs   # must match the hashes below', 'WILDSENTIA_URL=https://wild.example/api node congo-hunter.mjs']);
    expect(q.quickSurvivor.at(-1)).toBe('WILDSENTIA_URL=https://wild.example/api node congo-survivor.mjs blue_duiker');
    expect(q.quickSurvivor[1]).toBe('curl -O https://wild.example/api/agents/examples/congo-survivor.mjs');
    // The page fills every quick start block from the same commands.
    expect(commands('https://wild.example/api', true)).toMatchObject(q);
  });

  it('reads the wallet key without echo, says it must be a testnet throwaway, and never puts a key in the command', () => {
    const wallet = quickStart('https://wild.example/api').quickWallet.join('\n');
    expect(wallet).toMatch(/^read -rs WILDSENTIA_WALLET_KEY && export WILDSENTIA_WALLET_KEY/);
    expect(wallet).toMatch(/TESTNET-only throwaway/);
    expect(wallet).not.toMatch(/0x[0-9a-fA-F]{20,}/);
  });

  it('lists the hash of each downloaded file, and nothing from a server without the starter agents', () => {
    const clientScript = { path: '/agents/client.mjs', sha256: 'c'.repeat(64) };
    expect(quickStartFiles({ clientScript })).toEqual([]);
    expect(quickStartFiles({ clientScript, examples: [] })).toEqual([]);
    expect(quickStartFiles({ clientScript, examples: [
      { name: 'congo-hunter.mjs', path: '/agents/examples/congo-hunter.mjs', sha256: 'h'.repeat(64) },
      { name: 'congo-survivor.mjs', path: '/agents/examples/congo-survivor.mjs', sha256: 's'.repeat(64) },
      { name: 'other.mjs', path: '/agents/examples/other.mjs', sha256: 'o'.repeat(64) }] })).toEqual([
      { name: 'client.mjs', sha256: 'c'.repeat(64) }, { name: 'congo-hunter.mjs', sha256: 'h'.repeat(64) }, { name: 'congo-survivor.mjs', sha256: 's'.repeat(64) }]);
  });
});
