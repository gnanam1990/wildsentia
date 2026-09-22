import { describe, expect, it } from 'vitest';
import { VANA_VERSION } from '../src/index.js';

describe('toolchain', () => {
  it('exports a version string', () => {
    expect(VANA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
