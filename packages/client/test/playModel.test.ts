import { describe, expect, it } from 'vitest';

describe('a command while the world steps (1A.3 review)', () => {
  it('is sent again after world_busy, up to three times; other errors are final', async () => {
    const { retryWhenBusy } = await import('../src/playModel.js');
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    let calls = 0;
    expect(await retryWhenBusy(async () => { if (++calls < 3) throw new Error('world_busy'); return 'ok'; }, wait)).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryWhenBusy(async () => { calls++; throw new Error('world_busy'); }, wait)).rejects.toThrow('world_busy');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryWhenBusy(async () => { calls++; throw new Error('not_possessing'); }, wait)).rejects.toThrow('not_possessing');
    expect(calls).toBe(1);
  });
});
