import { describe, expect, it, vi } from 'vitest';
import { LazyDialog } from '../src/lazyDialog.js';

describe('on-demand observer dialog loading', () => {
  it('loads once, gives immediate status, and opens with the requested subject', async () => {
    const status = { textContent: '' } as HTMLElement;
    let finish!: (open: (id: string) => void) => void;
    const load = vi.fn(() => new Promise<(id: string) => void>(resolve => { finish = resolve; }));
    const shown = vi.fn();
    const dialog = new LazyDialog<[string]>('history', status, load);
    const pending = dialog.open('deer-1');
    expect(status.textContent).toBe('Opening history…');
    expect(await dialog.open('deer-2')).toBe(false);
    finish(shown);
    expect(await pending).toBe(true);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('deer-1');
    expect(status.textContent).toBe('');
    expect(await dialog.open('deer-3')).toBe(true);
    expect(shown).toHaveBeenLastCalledWith('deer-3');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports a failed import and retries on the next request', async () => {
    const status = { textContent: '' } as HTMLElement;
    const shown = vi.fn();
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(shown);
    const dialog = new LazyDialog<[string]>('event map', status, load);
    expect(await dialog.open('first')).toBe(false);
    expect(status.textContent).toBe('event map unavailable. Try opening it again.');
    expect(await dialog.open('second')).toBe(true);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('second');
    expect(load).toHaveBeenCalledTimes(2);
    expect(status.textContent).toBe('');
  });
});
