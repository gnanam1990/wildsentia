/** Viewer-only budgets. Never change the authoritative world or remove animals from its data. */
export type RenderTier = 'smooth' | 'balanced' | 'high';
export type QualityMode = 'auto' | RenderTier;
export const SHADOW_HZ: Readonly<Record<RenderTier, number>> = { smooth: 20, balanced: 30, high: 60 };

/** Only shadow maps are rate-limited, never animal motion. Refresh immediately on jumps
 * or tier changes; no unbounded catch-up work after a suspended tab resumes. */
export class ShadowCadence {
  #last: number | null = null;
  #tier: RenderTier | null = null;
  #target = { x: 0, y: 0, z: 0 };
  #light = { x: 0, y: 0, z: 0 };
  next(now: number, tier: RenderTier, target: { x: number; y: number; z: number },
    light: { x: number; y: number; z: number }, force = false): boolean {
    if (!Number.isFinite(now)) return false;
    const distance = (a: typeof target, b: typeof target) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (!force && this.#last !== null && this.#tier === tier && now >= this.#last
      && now - this.#last < 1000 / SHADOW_HZ[tier] - 0.1
      && distance(target, this.#target) < 3 && distance(light, this.#light) < 3) return false;
    this.#last = now; this.#tier = tier;
    this.#target = { x: target.x, y: target.y, z: target.z };
    this.#light = { x: light.x, y: light.y, z: light.z };
    return true;
  }
}
export const RENDER_BUDGETS = {
  smooth: { pixelRatio: 1, pixels: 1280 * 720, shadowSize: 512, grassStride: 8, curvedRadius: 8, animalModels: 24, animalRadius: 300 },
  balanced: { pixelRatio: 1.25, pixels: 1920 * 1080, shadowSize: 1024, grassStride: 4, curvedRadius: 16, animalModels: 48, animalRadius: 500 },
  high: { pixelRatio: 1.75, pixels: 2560 * 1440, shadowSize: 2048, grassStride: 1, curvedRadius: 32, animalModels: 120, animalRadius: 800 },
} as const;

export function qualityMode(value: unknown): QualityMode {
  return value === 'smooth' || value === 'balanced' || value === 'high' ? value : 'auto';
}

export function renderPixelRatio(tier: RenderTier, width: number, height: number, deviceRatio: number): number {
  const budget = RENDER_BUDGETS[tier];
  return Math.min(Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1, budget.pixelRatio,
    Math.sqrt(budget.pixels / (Math.max(1, width) * Math.max(1, height))));
}

/** Sustained frame delivery, not a claimed GPU benchmark. Auto only steps down this visit:
 * no repeated quality oscillation; selecting Auto again explicitly starts a fresh trial. */
export class AdaptiveQuality {
  tier: RenderTier;
  #slowMs = 0;
  #samples = 0;
  #elapsed = 0;
  constructor(public mode: QualityMode = 'auto') { this.tier = mode === 'auto' ? 'balanced' : mode; }
  select(mode: QualityMode): void {
    this.mode = mode; this.tier = mode === 'auto' ? 'balanced' : mode; this.resetTiming();
  }
  resetTiming(): void { this.#slowMs = 0; this.#samples = 0; this.#elapsed = 0; }
  sample(milliseconds: number): boolean {
    if (this.mode !== 'auto' || this.tier === 'smooth') return false;
    // Ignore suspension and one-off loading stalls; don't hide sustained poor frame delivery.
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 250) { this.resetTiming(); return false; }
    this.#elapsed += milliseconds; this.#samples++;
    if (this.#elapsed < 1000) return false;
    this.#slowMs = this.#elapsed / this.#samples > 26 ? this.#slowMs + this.#elapsed : 0;
    this.#elapsed = 0; this.#samples = 0;
    if (this.#slowMs < 3000) return false;
    this.tier = 'smooth'; this.resetTiming(); return true;
  }
}

/** RAF-driven frame ceiling (60 Hz unless asked otherwise); no hidden-tab rendering or giant resume delta. */
export class RenderPacer {
  readonly #period: number;
  /** `maxFps` above 60 is for filming with a slowed clock (tools/video/film.ts); clamped to 30–240. */
  constructor(maxFps = 60) { this.#period = 1000 / Math.min(240, Math.max(30, Number.isFinite(maxFps) ? maxFps : 60)); }
  #scheduled: number | null = null;
  #rendered: number | null = null;
  reset(): void { this.#scheduled = null; this.#rendered = null; }
  next(now: number, hidden = false): number | null {
    if (hidden || !Number.isFinite(now)) { this.reset(); return null; }
    if (this.#scheduled === null || this.#rendered === null || now < this.#rendered) {
      this.#scheduled = now; this.#rendered = now; return 0;
    }
    const period = this.#period, elapsed = now - this.#scheduled;
    if (elapsed < period - 0.1) return null;
    this.#scheduled += Math.max(1, Math.floor((elapsed + 0.1) / period)) * period;
    const delta = now - this.#rendered; this.#rendered = now; return delta;
  }
}
