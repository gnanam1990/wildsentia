import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTypedData, draftError, termsFrom, toMetres, toPixel, typedDataForWallet, type FormValues } from '../src/challengeNewModel.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const form = (over: Partial<FormValues> = {}): FormValues => ({ template: 'survive', speciesId: 'chital', days: 3, count: 1, x: 0, z: 0,
  zone: null, noRun: false, herd: null, briefing: '', ...over });

describe('create flow', () => {
  it('is its own page with every field the server accepts', () => {
    expect(read('vite.config.ts')).toContain("challengeNew: 'challenge-new.html'");
    const html = read('challenge-new.html');
    expect(html).toContain('src="/src/challengeNew.ts"');
    for (const id of ['new-species', 'new-template', 'new-days', 'new-count', 'new-x', 'new-z', 'new-zone-on', 'new-zone-radius', 'new-norun',
      'new-herd-on', 'new-herd-distance', 'new-briefing', 'new-prize', 'new-deadline', 'new-map', 'new-review', 'new-description', 'new-sign', 'new-status'])
      expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain('maxlength="280"');
  });

  it('builds the terms for each goal and rule exactly as the server reads them', () => {
    expect(termsFrom(form())).toEqual({ template: 'survive', speciesId: 'chital', days: 3, rules: [], briefing: '' });
    expect(termsFrom(form({ template: 'hunt', speciesId: 'tiger', count: 2 }))).toEqual({ template: 'hunt', speciesId: 'tiger', count: 2, rules: [], briefing: '' });
    expect(termsFrom(form({ template: 'escape', count: 4 }))).toMatchObject({ template: 'escape', count: 4 });
    expect(termsFrom(form({ template: 'reach', x: 1200.6, z: 300.2, zone: { x: 1000, z: 300, radiusM: 900 }, noRun: true, herd: 60, briefing: '  Go east. ' })))
      .toEqual({ template: 'reach', speciesId: 'chital', x: 1201, z: 300, briefing: 'Go east.',
        rules: [{ type: 'zone', x: 1000, z: 300, radiusM: 900 }, { type: 'noRun' }, { type: 'herd', maxDistanceM: 60 }] });
  });

  it('maps the island picture to island metres and back', () => {
    // 20 patches of 300 m, the first centred on 0: the island spans -150 to 5850 m.
    expect(toMetres(0, 0, 600)).toEqual({ x: -150, z: -150 });
    expect(toMetres(300, 150, 600)).toEqual({ x: 2850, z: 1350 });
    expect(toPixel(2850, 1350, 600)).toEqual({ px: 300, py: 150 });
  });

  it('gives the wallet the typed data in the form it signs', () => {
    const typed = { domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' },
      types: { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }] }, primaryType: 'ReceiveWithAuthorization',
      message: { from: '0x' + 'a'.repeat(40), to: '0x' + 'c'.repeat(40), value: '5000000', validAfter: '0', validBefore: '1790000000', nonce: '0x' + '1'.repeat(64) } };
    const out = typedDataForWallet(typed);
    expect(out.types.EIP712Domain).toEqual([{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]);
    expect(out.types.ReceiveWithAuthorization).toEqual(typed.types.ReceiveWithAuthorization);
    expect(out.message).toEqual(typed.message);
  });

  it('refuses to sign typed data for another wallet, chain or token', () => {
    const info = { chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', contract: '0x' + 'c'.repeat(40) };
    const typed = { domain: { chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' }, primaryType: 'ReceiveWithAuthorization',
      message: { from: '0x' + 'A'.repeat(40), to: '0x' + 'c'.repeat(40) } };
    const account = '0x' + 'a'.repeat(40);
    expect(checkTypedData(typed, account, info)).toBeNull();
    expect(checkTypedData(typed, '0x' + 'b'.repeat(40), info)).toBe('wrong_wallet');
    expect(checkTypedData({ ...typed, domain: { ...typed.domain, chainId: 1 } }, account, info)).toBe('wrong_chain');
    expect(checkTypedData({ ...typed, domain: { ...typed.domain, verifyingContract: '0x' + 'd'.repeat(40) } }, account, info)).toBe('wrong_token');
    expect(checkTypedData({ ...typed, message: { ...typed.message, to: '0x' + 'e'.repeat(40) } }, account, info)).toBe('wrong_contract');
    expect(checkTypedData({ ...typed, primaryType: 'Permit' }, account, info)).toBe('wrong_kind');
  });

  it('turns server refusals into plain words', () => {
    expect(draftError('zone_too_small_for_reach')).toMatch(/zone/);
    expect(draftError('not_a_herd_species')).toMatch(/herd/);
    expect(draftError('daily_limit')).toMatch(/three/);
    expect(draftError('briefing_no_links')).toMatch(/links/);
    expect(draftError('something_else')).toBe('The server refused this challenge (something_else).');
  });
});
