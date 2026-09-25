import { describe, expect, it } from 'vitest';
import { restoreFollowOnOpen } from '../src/followSubscription.js';

function connection() {
  const events = new EventTarget(); const sent: string[] = [];
  return { socket: { addEventListener: events.addEventListener.bind(events), send: (data: string) => sent.push(data) },
    open: () => events.dispatchEvent(new Event('open')), sent };
}
describe('observer follow subscription restoration', () => {
  it('restores the current selection on a new connection, once, without triggering view resets', () => {
    const first = connection(); let followed: string | null = 'first';
    restoreFollowOnOpen(first.socket, () => followed);
    expect(first.sent).toEqual([]);
    followed = 'latest'; first.open(); first.open();
    expect(first.sent.map((s) => JSON.parse(s))).toEqual([{ type: 'watch', actorId: 'latest' }]);
    const reconnect = connection(); restoreFollowOnOpen(reconnect.socket, () => followed); reconnect.open();
    expect(reconnect.sent).toEqual(first.sent);
    expect(followed).toBe('latest');
  });
  it('does not resubscribe a stale animal when free-camera was selected while disconnected', () => {
    const next = connection(); let followed: string | null = 'previous';
    restoreFollowOnOpen(next.socket, () => followed); followed = null; next.open();
    expect(next.sent).toEqual([]);
  });
});
