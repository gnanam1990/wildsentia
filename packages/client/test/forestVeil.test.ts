import { describe, expect, it, vi } from 'vitest';
import { ForestVeil, VEIL_ASSET_PATIENCE_MS, veilProgress, veilStage } from '../src/forestVeil.js';

const state = (over = {}) => ({ connected: false, sceneReady: false, loaded: 0, total: 0, framesAfterReady: 0, ...over });

describe('first-visit veil', () => {
  it('fills the bar from real steps: connection, scene, then each loaded asset', () => {
    expect(veilProgress(state())).toBe(0);
    expect(veilProgress(state({ connected: true }))).toBeCloseTo(0.1);
    expect(veilProgress(state({ connected: true, sceneReady: true, loaded: 5, total: 10 }))).toBeCloseTo(0.25 + 0.75 * 0.5);
    expect(veilProgress(state({ connected: true, sceneReady: true, loaded: 10, total: 10 }))).toBe(1);
  });

  it('is ready only with the scene in, nothing loading and a frame drawn', () => {
    expect(veilStage(state({ connected: true }))).toBe('scene');
    expect(veilStage(state({ connected: true, sceneReady: true, loaded: 3, total: 4, framesAfterReady: 5 }))).toBe('assets');
    expect(veilStage(state({ connected: true, sceneReady: true, loaded: 4, total: 4, framesAfterReady: 1 }))).toBe('assets');
    expect(veilStage(state({ connected: true, sceneReady: true, loaded: 4, total: 4, framesAfterReady: 2 }))).toBe('ready');
  });

  it('lifts once everything has loaded and never counts backwards', () => {
    const veil = new ForestVeil(null, () => 0);
    veil.connected(); veil.assets(2, 6); veil.assets(1, 6);
    veil.sceneReady(); veil.frameDrawn(); veil.frameDrawn();
    expect(veil.lifted).toBe(false);
    veil.assets(6, 6); veil.frameDrawn();
    expect(veil.lifted).toBe(true);
  });

  it('does not keep a visitor waiting forever on one slow model', () => {
    let now = 0;
    const veil = new ForestVeil(null, () => now);
    veil.sceneReady(); veil.assets(3, 9);
    veil.frameDrawn(); veil.frameDrawn();
    expect(veil.lifted).toBe(false);
    now = VEIL_ASSET_PATIENCE_MS + 1; veil.frameDrawn();
    expect(veil.lifted).toBe(true);
  });

  it('writes progress and stage text into the page and hides itself when lifted', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const classes = new Set<string>(), attrs = new Map<string, string>();
    const root = { hidden: false, classList: { add: (c: string) => classes.add(c) }, setAttribute: (k: string, v: string) => attrs.set(k, v),
      addEventListener: () => {} } as unknown as HTMLElement;
    const bar = { style: { transform: '' } } as unknown as HTMLElement, text = { textContent: '' } as unknown as HTMLElement;
    const veil = new ForestVeil({ root, bar, text }, () => 0);
    veil.connected();
    expect(bar.style.transform).toBe('scaleX(0.100)');
    expect(text.textContent).toMatch(/where every animal is/);
    veil.sceneReady(); veil.frameDrawn(); veil.frameDrawn();
    expect(classes.has('is-lifting')).toBe(true);
    expect(attrs.get('aria-busy')).toBe('false');
    expect(root.hidden).toBe(true);
    vi.unstubAllGlobals();
  });
});
