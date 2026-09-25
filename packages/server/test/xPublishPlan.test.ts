import { describe, expect, it } from 'vitest';
import { xPublishPlan } from '../src/xPublishPlan.js';

const input = { draftId: '12345678-1234-1234-1234-123456789abc',
  sourceFingerprint: 'a'.repeat(32), text: 'Vana day 1, hour 1: A sambar was born in the forest. Recorded simulation event; not a live alert.' };

describe('X publishing preparation contract', () => {
  it('returns a stable, credential-free, non-sending request shape', () => {
    const plan = xPublishPlan(input);
    expect(plan).toEqual(xPublishPlan(input));
    expect(plan).toMatchObject({ provider: 'x', status: 'not_sent', published: false,
      request: { method: 'POST', url: 'https://api.x.com/2/tweets', body: {
        text: `${input.text} [VANA record ${input.draftId}]` } } });
    expect(xPublishPlan({ ...input, draftId: '12345678-1234-1234-1234-123456789abd' }).request.body.text)
      .not.toBe(plan.request.body.text);
    expect(JSON.stringify(plan)).not.toMatch(/Bearer|access_token|client_secret|Authorization/);
    expect(xPublishPlan({ ...input, text: input.text + ' More.' }).fingerprint).not.toBe(plan.fingerprint);
  });

  it('rejects malformed identities and over-limit or multiline text', () => {
    expect(() => xPublishPlan({ ...input, draftId: 'bad' })).toThrow();
    expect(() => xPublishPlan({ ...input, sourceFingerprint: 'bad' })).toThrow();
    expect(() => xPublishPlan({ ...input, text: 'x'.repeat(240) })).toThrow();
    expect(() => xPublishPlan({ ...input, text: 'one\ntwo' })).toThrow();
  });
});
