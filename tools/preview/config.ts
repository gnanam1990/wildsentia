import type { TerrainProfile } from '@vana/shared';

export function previewPorts(profile: TerrainProfile) {
  if (profile === 'mainland') return { database: 65439, api: 8085, client: 5178 };
  if (profile === 'island_v1') return { database: 65438, api: 8086, client: 5179 };
  throw new Error('Invalid preview terrain profile');
}

/** Existing version-1 directories stay mainland. A resume never silently changes geography/ports. */
export function parsePreviewConfig(value: unknown, requested?: string) {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid preview metadata');
  const v = value as Record<string, unknown>;
  const profile = v.version === 1 ? 'mainland' :
    (v.version === 2 || v.version === 3) ? v.terrainProfile : undefined;
  if (profile !== 'mainland' && profile !== 'island_v1') throw new Error('Invalid preview metadata');
  const ports = previewPorts(profile);
  const communityProfile = v.version === 3 ? v.communityProfile : 'none';
  if (v.port !== ports.database || typeof v.password !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(v.password)
    || (v.version === 1 && v.terrainProfile !== undefined && v.terrainProfile !== 'mainland')
    || (v.version === 3 && communityProfile !== (profile === 'island_v1' ? 'household_v1' : 'none'))
    || (v.version !== 3 && v.communityProfile !== undefined)) throw new Error('Invalid preview metadata');
  if (requested !== undefined && requested !== profile) throw new Error('Preview profile mismatch; create a separate world');
  return { profile, communityProfile: communityProfile as 'none' | 'household_v1', ports, password: v.password };
}
