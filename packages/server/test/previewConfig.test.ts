import { describe, expect, it } from 'vitest';
import { parsePreviewConfig, previewPorts } from '../../../tools/preview/config.js';
describe('isolated preview metadata', () => {
  it('keeps legacy previews on original mainland ports', () => {
    const c = parsePreviewConfig({ version: 1, port: 65439, password: 'p'.repeat(32) });
    expect(c.profile).toBe('mainland'); expect(c.ports).toEqual({ database: 65439, api: 8085, client: 5178 });
  });
  it('uses separate fixed ports for new island worlds and refuses a requested topology change', () => {
    const c = { version: 2, port: 65438, terrainProfile: 'island_v1', password: 'p'.repeat(32) };
    expect(parsePreviewConfig(c).ports).toEqual({ database: 65438, api: 8086, client: 5179 });
    expect(parsePreviewConfig(c).communityProfile).toBe('none');
    expect(() => parsePreviewConfig(c, 'mainland')).toThrow('profile mismatch');
  });
  it('runs a fresh island with a persistent household without upgrading older previews', () => {
    const c = { version: 3, port: 65438, terrainProfile: 'island_v1',
      communityProfile: 'household_v1', password: 'p'.repeat(32) };
    expect(parsePreviewConfig(c).communityProfile).toBe('household_v1');
    expect(() => parsePreviewConfig({ ...c, communityProfile: 'none' })).toThrow('Invalid');
  });
  it('rejects unknown versions, profiles, ports and invalid credentials before connecting', () => {
    const good = { version: 2, port: 65438, terrainProfile: 'island_v1', password: 'p'.repeat(32) };
    for (const patch of [{ version: 4 }, { port: 5432 }, { terrainProfile: 'ocean' }, { password: '' }])
      expect(() => parsePreviewConfig({ ...good, ...patch })).toThrow('Invalid');
    expect(() => previewPorts('unknown' as never)).toThrow('Invalid');
  });
});
