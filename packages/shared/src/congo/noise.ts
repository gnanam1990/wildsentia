/** Seeded lattice hash in [0, 1). Pure integer mixing; never Math.random. */
export function hash01(seed: number, ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4_294_967_296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Bilinear value noise in [0, 1) with smoothstep easing; one octave at the given wavelength. */
export function valueNoise(seed: number, x: number, z: number, wavelengthM: number, salt: number): number {
  const gx = x / wavelengthM, gz = z / wavelengthM, ix = Math.floor(gx), iz = Math.floor(gz);
  const tx = smooth(gx - ix), tz = smooth(gz - iz);
  const a = hash01(seed, ix, iz, salt), b = hash01(seed, ix + 1, iz, salt);
  const c = hash01(seed, ix, iz + 1, salt), d = hash01(seed, ix + 1, iz + 1, salt);
  const top = a + (b - a) * tx, bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}
