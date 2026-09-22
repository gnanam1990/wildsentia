export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(maxExclusive: number): number;
  bool(p: number): boolean;
  gaussian(mean: number, sd: number): number;
  fork(label: string): Rng;
}

function hashLabel(label: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** sfc32 — small, fast, well-distributed, and trivially reproducible. */
export function createRng(seed: number, label: string): Rng {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  let b = hashLabel(label);
  let c = (seed + 0x85ebca6b) >>> 0;
  let d = (b ^ 0xc2b2ae35) >>> 0;

  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    d = (d + 1) >>> 0;
    const r = (t + d) >>> 0;
    c = (c + r) >>> 0;
    return r / 4294967296;
  };

  // Discard the first few outputs so nearby seeds diverge immediately.
  for (let i = 0; i < 12; i++) next();

  let forkCounter = 0;
  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    bool: (p) => next() < p,
    gaussian(mean, sd) {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    fork: (childLabel) =>
      createRng((seed ^ hashLabel(childLabel)) >>> 0, `${label}/${childLabel}/${forkCounter++}`),
  };
  return rng;
}
