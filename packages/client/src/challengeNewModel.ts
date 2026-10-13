import { worldGrid } from './worldGrid.js';


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

/** The world's map: its grid's patches, the first centred on 0. */
const extent = () => { const g = worldGrid(); return { edge: -g.patchM / 2, spanX: g.cols * g.patchM, spanZ: g.rows * g.patchM }; };
export function toMetres(px: number, py: number, size: number): { x: number; z: number } {
  const { edge, spanX, spanZ } = extent();
  return { x: Math.round(edge + px / size * spanX), z: Math.round(edge + py / size * spanZ) };
}
export function toPixel(x: number, z: number, size: number): { px: number; py: number } {
  const { edge, spanX, spanZ } = extent();
  return { px: (x - edge) / spanX * size, py: (z - edge) / spanZ * size };
}

interface TypedData { domain: Record<string, unknown>; types?: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }

/** eth_signTypedData_v4 wants the domain's own type spelled out; the server's typed data leaves it to the library. */
export function typedDataForWallet<T extends TypedData>(t: T): T & { types: Record<string, unknown> & { EIP712Domain: Array<{ name: string; type: string }> } } {
  const fields: Array<[string, string]> = [['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address']];
  const EIP712Domain = fields.filter(([name]) => t.domain[name] !== undefined).map(([name, type]) => ({ name, type }));
  // Built here, last: a domain type sent by the server never replaces it.
  return { ...t, types: { ...(t.types ?? {}), EIP712Domain } };
}

/** EIP-3009's ReceiveWithAuthorization, field for field: nothing else is ever signed. */
const RECEIVE = [['from', 'address'], ['to', 'address'], ['value', 'uint256'], ['validAfter', 'uint256'], ['validBefore', 'uint256'], ['nonce', 'bytes32']];

/** A USDC amount typed by a person, as 6-decimal units; null if it is not one. */
export function usdcAtomic(text: string): string | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim());
  return m ? (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))).toString() : null;
}

/** The same form gives the same draft: a review is not repeated (each draft counts while it waits). */
export const draftKey = (body: { terms: unknown; prizeUsdc: string; days: number }) => JSON.stringify(body);

/**
 * Nothing is signed unless it is a USDC receive authorization from the connected wallet, on the
 * challenge chain, for the USDC token and the challenge contract the server names.
 */
export function checkTypedData(t: TypedData, account: string, info: { chainId: number; usdc: string; contract: string }, expectedValue?: string | null): string | null {
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (t.primaryType !== 'ReceiveWithAuthorization') return 'wrong_kind';
  const types = t.types ?? {};
  const fields = types.ReceiveWithAuthorization as Array<{ name: string; type: string }> | undefined;
  if (Object.keys(types).length !== 1 || !Array.isArray(fields) || fields.length !== RECEIVE.length
    || fields.some((f, i) => f.name !== RECEIVE[i]![0] || f.type !== RECEIVE[i]![1])) return 'wrong_types';
  if (expectedValue !== undefined && String(t.message.value) !== expectedValue) return 'wrong_amount';
  if (!same(t.message.from, account)) return 'wrong_wallet';
  if (Number(t.domain.chainId) !== info.chainId) return 'wrong_chain';
  if (!same(t.domain.verifyingContract, info.usdc)) return 'wrong_token';
  if (!same(t.message.to, info.contract)) return 'wrong_contract';
  return null;
}

const DRAFT_ERRORS: Record<string, string> = {
  unknown_species: 'Pick a species.', bad_days: 'Pick how many forest days.',
  deadline_too_short: 'The deadline is too soon: nobody could keep the animal alive that many forest days by then. Pick a later deadline or fewer days.', bad_count: 'Pick how many (1 to 5).',
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
  wrong_types: 'The authorization was not the standard USDC one, so nothing was signed.',
  wrong_amount: 'The authorization was not for the prize you typed, so nothing was signed.',
  signature_does_not_match: 'The signature did not match this draft. Review it again and sign once more.',
  not_found: 'That draft no longer exists. Review the challenge again.', already_queued: 'This challenge is already on its way to Arc.',
  rate_limited: 'Too many requests just now. Wait a minute and try again.',
};

/** What went wrong while signing: the person cancelling, the browser, or the server's refusal. */
export function signError(e: unknown): string {
  if (e && typeof e === 'object' && (e as { code?: unknown }).code === 4001) return 'You cancelled in your wallet; nothing was signed or sent.';
  const code = e instanceof Error ? e.message : '';
  if (!(e instanceof Error) || e.constructor !== Error || !/^[a-z_]+$/.test(code)) return 'Something went wrong in the browser; nothing was sent. Try again.';
  return draftError(code);
}
export const draftError = (code: string) => DRAFT_ERRORS[code] ?? `The server refused this challenge (${code}).`;

export const HABITAT_COLOURS: Record<string, string> = { shola: '#2f5d3a', grassland: '#8aa65a', riparian: '#4f8f6f', rock: '#8c8478',
  marsh: '#5f7f68', water: '#2b5c7d' };

export type RelayStatus = { state: 'not_sent' | 'sending' } | { state: 'failed'; error: string } | { state: 'created'; challengeId: number };
const RELAY_FAILURES: Record<string, string> = {
  authorization_expired: 'The signed authorization ran out before it could be sent. No USDC was taken: review the challenge and sign again.',
  reverted: 'Arc refused the challenge, so no USDC was taken. Review it and try again.',
};

/** What the creator is told while a signed challenge goes to Arc; `done` stops the page asking. */
export function relayMessage(s: RelayStatus): { text: string; done: boolean; challengeId?: number } {
  if (s.state === 'created') return { text: `Created on Arc as challenge ${s.challengeId}.`, done: true, challengeId: s.challengeId };
  if (s.state === 'failed') return { text: RELAY_FAILURES[s.error] ?? `Arc did not take the challenge (${s.error}), so no USDC was taken.`, done: true };
  return { text: 'Sent to Arc. Waiting for it to be confirmed (usually under a minute).', done: false };
}
