import { describe, expect, it } from 'vitest';
import { ReturnPath } from '../src/returnPath.js';

describe('closing a dialog goes back only where it was opened from', () => {
  it('reopens the village list only when the history was read from it', () => {
    const path = new ReturnPath(), opened: string[] = [];
    path.openedFrom(() => opened.push('village'));
    expect(path.close()).toBe(true);
    expect(opened).toEqual(['village']);
    // Read next from the event map: closing returns there, not to the village.
    path.openedFrom(() => opened.push('map'));
    expect(path.close()).toBe(true);
    expect(opened).toEqual(['village', 'map']);
    // Opened from the forest itself: closing reopens nothing.
    path.openedFrom(null);
    expect(path.close()).toBe(false);
    expect(opened).toEqual(['village', 'map']);
  });
  it('goes back once: a second close, or a close without an opening, reopens nothing', () => {
    const path = new ReturnPath(); let count = 0;
    expect(path.close()).toBe(false);
    path.openedFrom(() => { count++; });
    path.close(); path.close();
    expect(count).toBe(1);
  });
});
