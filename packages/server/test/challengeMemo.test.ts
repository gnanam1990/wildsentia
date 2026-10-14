import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, hexToString, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { ARC_MEMO_CONTRACT, memoCall, settlementNote } from '../src/challenges/chain.js';
import { challengesAbi } from '../src/challenges/challengesAbi.js';
import { challengesConfig } from '../src/challenges/runtime.js';

// Design §12: resolve and refund go through Arc's Memo contract with a readable note, shown on the
// explorer. Memo forwards the call from the sender's own account (CallFrom), so the escrow still
// sees the evaluator as msg.sender (docs.arc.io/arc/concepts/transaction-memos).
const memoAbi = parseAbi(['function memo(address target, bytes data, bytes32 memoId, bytes memoData)']);
const escrow = `0x${'1'.repeat(40)}` as Hex;

describe('challenge settlements through the Arc Memo contract', () => {
  it('wraps the escrow call unchanged, with a stable id and the note as UTF-8', () => {
    const inner = encodeFunctionData({ abi: challengesAbi, functionName: 'refund', args: [42n] });
    const wrapped = memoCall(escrow, inner, { fn: 'refund', id: 42 });
    const { functionName, args } = decodeFunctionData({ abi: memoAbi, data: wrapped });
    expect(functionName).toBe('memo');
    expect(args[0].toLowerCase()).toBe(escrow);
    expect(args[1]).toBe(inner);
    expect(args[2]).toBe(keccak256(stringToHex('wildsentia:challenge:42:refund')));
    expect(hexToString(args[3])).toBe('Wildsentia challenge #42: refunded');
  });
  it('says what happened in a short note', () => {
    expect(settlementNote({ fn: 'resolve', id: 7, winner: `0x${'ab'.repeat(20)}`, resultHash: `0x${'0'.repeat(64)}` }))
      .toBe('Wildsentia challenge #7: won by 0xabab…abab');
    expect(settlementNote({ fn: 'refund', id: 7 })).toBe('Wildsentia challenge #7: refunded');
  });
  it('is on only when configured (Arc mainnet and testnet share the predeploy address)', () => {
    const full = { VANA_CHALLENGES: '1', VANA_LIVE_AGENTS: '1', VANA_CHALLENGES_RPC_URL: 'https://rpc.testnet.arc.io',
      VANA_CHALLENGES_CHAIN_ID: '5042002', VANA_CHALLENGES_CONTRACT: '0x' + '1'.repeat(40), VANA_CHALLENGES_USDC: '0x3600000000000000000000000000000000000000',
      VANA_CHALLENGES_EVALUATOR_KEY: '0x' + 'a'.repeat(64), VANA_CHALLENGES_FROM_BLOCK: '100', VANA_CHALLENGES_ADMIN_TOKEN: 'x'.repeat(40),
      VANA_CHALLENGES_USDC_DOMAIN_NAME: 'USDC', VANA_CHALLENGES_USDC_DOMAIN_VERSION: '2' };
    expect(challengesConfig(full)!.memoContract).toBeNull();
    expect(challengesConfig({ ...full, VANA_CHALLENGES_MEMO: '1' })!.memoContract).toBe(ARC_MEMO_CONTRACT);
    expect(ARC_MEMO_CONTRACT).toBe('0x5294E9927c3306DcBaDb03fe70b92e01cCede505');
    expect(() => challengesConfig({ ...full, VANA_CHALLENGES_MEMO: 'yes' })).toThrow('VANA_CHALLENGES_MEMO');
  });
});
