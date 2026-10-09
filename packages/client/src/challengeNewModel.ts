import { GRID_SIZE, PATCH_METRES } from '@vana/shared';

/** The create flow's logic, kept apart from the page so it can be tested (spec §8, §13, §14). */
export interface FormValues {
  template: 'survive' | 'hunt' | 'escape' | 'reach'; speciesId: string; days: number; count: number; x: number; z: number;
  zone: { x: number; z: number; radiusM: number } | null; noRun: boolean; herd: number | null; briefing: string;
}

/** The terms exactly as POST /challenges/drafts reads them. Coordinates are whole metres. */
export function termsFrom(f: FormValues): Record<string, unknown> {
  const goal = f.template === 'survive' ? { days: f.days } : f.template === 'reach' ? { x: Math.round(f.x), z: Math.round(f.z) } : { count: f.count };
  const rules: Array<Record<string, unknown>> = [];
  if (f.zone) rules.push({ type: 'zone', x: Math.round(f.zone.x), z: Math.round(f.zone.z), radiusM: Math.round(f.zone.radiusM) });
  if (f.noRun) rules.push({ type: 'noRun' });
  if (f.herd !== null) rules.push({ type: 'herd', maxDistanceM: Math.round(f.herd) });
  return { template: f.template, speciesId: f.speciesId, ...goal, rules, briefing: f.briefing.trim() };
}

/** The island: GRID_SIZE patches of PATCH_METRES a side, the first centred on 0. */
const SPAN = GRID_SIZE * PATCH_METRES, EDGE = -PATCH_METRES / 2;
export function toMetres(px: number, py: number, size: number): { x: number; z: number } {
  return { x: Math.round(EDGE + px / size * SPAN), z: Math.round(EDGE + py / size * SPAN) };
}
export function toPixel(x: number, z: number, size: number): { px: number; py: number } {
  return { px: (x - EDGE) / SPAN * size, py: (z - EDGE) / SPAN * size };
}

interface TypedData { domain: Record<string, unknown>; types?: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

/** eth_signTypedData_v4 wants the domain's own type spelled out; the server's typed data leaves it to the library. */
export function typedDataForWallet<T extends TypedData>(t: T): T & { types: Record<string, unknown> & { EIP712Domain: Array<{ name: string; type: string }> } } {
  const fields: Array<[string, string]> = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address']];
  const EIP712Domain = fields.filter(([name]) => t.domain[name] !== undefined).map(([name, type]) => ({ name, type }));
  return { ...t, types: { EIP712Domain, ...(t.types ?? {}) } };
}

/**
 * Nothing is signed unless it is a USDC receive authorization from the connected wallet, on the
 * challenge chain, for the USDC token and the challenge contract the server names.
 */
export function checkTypedData(t: TypedData, account: string, info: { chainId: number; usdc: string; contract: string }): string | null {
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (t.primaryType !== 'ReceiveWithAuthorization') return 'wrong_kind';
  if (!same(t.message.from, account)) return 'wrong_wallet';
  if (Number(t.domain.chainId) !== info.chainId) return 'wrong_chain';
  if (!same(t.domain.verifyingContract, info.usdc)) return 'wrong_token';
  if (!same(t.message.to, info.contract)) return 'wrong_contract';
  return null;
}

const DRAFT_ERRORS: Record<string, string> = {
  unknown_species: 'Pick a species.', bad_days: 'Pick how many forest days.', bad_count: 'Pick how many (1 to 5).',
  not_a_hunter: 'That species does not hunt: pick a predator for a hunt goal.', not_hunted: 'Nothing hunts that species: pick prey for an escape goal.',
  target_not_on_land: 'The place to reach must be on land: pick it on the map.', target_outside_zone: 'The place to reach must be inside the zone.',
  zone_too_small_for_reach: 'The zone is too small: a start inside it must be able to lie a kilometre from the place to reach.',
  zone_not_on_land: 'The zone centre must be on land.', bad_zone_radius: 'The zone radius must be 200 to 3000 m.',
  bad_herd_distance: 'The herd distance must be 30 to 200 m.', not_a_herd_species: 'That species does not live in a herd, pack or troop.',
  no_run_cannot_hunt: 'A hunt goal cannot forbid running: a predator always sprints at the end of a hunt.',
  duplicate_rule: 'Each rule can be used once.', bad_prize: 'The prize is outside the allowed range.',
  briefing_no_links: 'The briefing cannot contain links.', briefing_no_addresses_or_keys: 'The briefing cannot contain addresses or keys.',
  briefing_bad_text: 'The briefing must be 280 characters or fewer.',
  daily_limit: 'You can create three challenges a day. Try again tomorrow.', wallet_required: 'Link a wallet first: the prize is taken from it.',
  x_account_too_new: 'Your X account must be at least 30 days old to create a challenge.', signed_out: 'Sign in with X first.',
  draft_expired: 'This draft expired. Review it again to get a fresh one.', already_created: 'This challenge was already created.',
  bad_signature: 'The wallet signature did not match. Nothing was sent.', wrong_wallet: 'Your wallet is not the one linked to your account. Switch to it.',
  wrong_chain: 'Your wallet is on another network. Switch it to the challenge network.', wrong_token: 'The authorization was not for USDC, so nothing was signed.',
  wrong_contract: 'The authorization was not for the challenge contract, so nothing was signed.', wrong_kind: 'The request was not a USDC authorization, so nothing was signed.',
  no_wallet: 'No browser wallet was found.',
};
export const draftError = (code: string) => DRAFT_ERRORS[code] ?? `The server refused this challenge (${code}).`;

export const HABITAT_COLOURS: Record<string, string> = { shola: '#2f5d3a', grassland: '#8aa65a', riparian: '#4f8f6f', rock: '#8c8478',
  marsh: '#5f7f68', water: '#2b5c7d' };
