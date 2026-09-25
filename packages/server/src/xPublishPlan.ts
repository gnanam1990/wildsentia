import { createHash } from 'node:crypto';

/** A transport-shaped preview only. This module deliberately has no HTTP client or credentials. */
export function xPublishPlan(input: { draftId: string; sourceFingerprint: string; text: string }) {
  // Draft templates can otherwise be identical for multiple events in one world-hour.
  // Put the full immutable draft ID in the public post so an UNKNOWN result can be
  // reconciled to exactly one local attempt, not merely a same-text sibling.
  const postText = `${input.text} [VANA record ${input.draftId}]`;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.draftId)
    || !/^[0-9a-f]{32}$/i.test(input.sourceFingerprint)
    || !input.text || Array.from(postText).length > 280 || /[\r\n]/.test(input.text))
    throw new Error('Invalid grounded X post plan');
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'x-create-post-v2', input.draftId, input.sourceFingerprint, postText,
  ])).digest('hex');
  return {
    provider: 'x', status: 'not_sent', published: false, draftId: input.draftId, fingerprint,
    request: { method: 'POST', url: 'https://api.x.com/2/tweets', body: { text: postText } },
    requirements: ['separate X account authorization', 'user-context write access', 'X API credits and spending limit'],
    notice: 'Dry run only. No X request was made. The fingerprint is local correlation, not an X idempotency key; never retry an uncertain live create without reconciling the account timeline.',
  } as const;
}
