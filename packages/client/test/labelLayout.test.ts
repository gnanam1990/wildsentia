import { describe, expect, it } from 'vitest';
import { stackLabels } from '../src/labelLayout.js';

describe('stackLabels', () => {
  const box = (x: number, y: number) => ({ x, y, width: 120, height: 24 });
  it('moves a label that would cover its partner clear of it, keeping their order', () => {
    expect(stackLabels(box(700, 515), box(730, 505))).toEqual({ x: 730, y: 515 - 24 - 4 });
    expect(stackLabels(box(700, 505), box(730, 515))).toEqual({ x: 730, y: 505 + 24 + 4 });
  });
  it('leaves labels that do not overlap where they are', () => {
    expect(stackLabels(box(300, 500), box(700, 500))).toEqual({ x: 700, y: 500 });
    expect(stackLabels(box(700, 300), box(700, 500))).toEqual({ x: 700, y: 500 });
  });
});
