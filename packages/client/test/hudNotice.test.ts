import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hud, type HudElements } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

function elements(): HudElements {
  const node = () => ({ innerHTML: '', textContent: '', title: '', querySelector: () => null, querySelectorAll: () => [] }) as unknown as HTMLElement;
  return { clock: node(), season: node(), population: node(), passport: node(), feed: node(), notice: node() };
}

afterEach(() => { vi.useRealTimers(); });

describe('the error notice', () => {
  it('clears itself a little while after the server reported the error', () => {
    vi.useFakeTimers();
    const nodes = elements(), store = new WorldStore(), hud = new Hud(nodes, store);
    store.apply({ type: 'error', message: 'unsupported message type' });
    hud.render(null);
    expect(nodes.notice.textContent).toBe('unsupported message type');
    vi.advanceTimersByTime(5_000); hud.render(null);
    expect(nodes.notice.textContent).toBe('unsupported message type');
    vi.advanceTimersByTime(10_000); hud.render(null);
    expect(nodes.notice.textContent).toBe('');
  });
});
