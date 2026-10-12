import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountAccountBox } from '../src/account.js';

afterEach(() => vi.unstubAllGlobals());
class Element {
  hidden = false; disabled = false; textContent = '';
  listeners = new Map<string, () => Promise<void>>();
  addEventListener(name: string, listener: () => Promise<void>) { this.listeners.set(name, listener); }
}
describe('account logout', () => {
  it('keeps the signed-in account after a failure and permits a confirmed retry', async () => {
    const elements = new Map(['account-box', 'account-status', 'account-signin', 'account-wallet', 'account-signout'].map(id => [`#${id}`, new Element()]));
    vi.stubGlobal('document', { querySelector: (id: string) => elements.get(id) });
    const account = { id: 'fixture', handle: 'forest', name: 'Forest', needs: [], xAccountDays: 100, wallet: null, agentId: 'ag_fixture' };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ account }))
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const changed = vi.fn();
    await mountAccountBox(changed);
    const button = elements.get('#account-signout')!, status = elements.get('#account-status')!;
    const click = button.listeners.get('click')!;
    for (let i = 0; i < 2; i++) {
      await click();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenLastCalledWith(account);
      expect(status.textContent).toMatch(/Sign out failed.*session may still be active/);
      expect(button.hidden).toBe(false); expect(button.disabled).toBe(false);
      expect(elements.get('#account-signin')!.hidden).toBe(true);
    }
    await click();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(button.hidden).toBe(true);
    expect(elements.get('#account-signin')!.hidden).toBe(false);
  });
});
