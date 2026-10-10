import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { XPublisher } from '../xPublisher.js';
import type { ChallengeSocialStore, SocialDraft } from './social.js';

/**
 * The owner's review of challenge posts (plan 3c), under /admin/social/challenges: the social
 * outbox's admin hook already demands the owner's token, limits the rate and takes JSON only.
 * A post goes to X once, after approval: the reservation is written before the single call, and a
 * result that cannot be known is never retried — the owner checks X and says what they found.
 */
const bodyOf = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
const view = (d: SocialDraft) => ({ id: d.id, challengeId: d.challengeId, kind: d.kind, body: d.body, status: d.status, xPostId: d.xPostId,
  note: d.note, createdAt: d.createdAt, reviewedAt: d.reviewedAt, publishedAt: d.publishedAt });

export function installChallengeSocial(app: FastifyInstance, deps: { social: ChallengeSocialStore; publisher?: XPublisher | undefined }): void {
  const { social, publisher } = deps;
  const pool = social.pool;
  const set = async (id: string, from: string[], to: string, extra: { note?: string; xPostId?: string | null } = {}) => {
    const { rows } = await pool.query(`update challenge_social_drafts set status = $3, note = coalesce($4, note),
      x_post_id = case when $5::boolean then $6 else x_post_id end,
      reviewed_at = case when $3 in ('approved', 'rejected', 'revoked') then now() else reviewed_at end,
      published_at = case when $3 = 'published' then now() else published_at end
      where id = $1 and status = any($2) returning id`, [id, from, to, extra.note ?? null, 'xPostId' in extra, extra.xPostId ?? null]);
    return rows.length === 1;
  };

  app.get('/admin/social/challenges', async () => {
    const drafts = await social.list();
    return { drafts: await Promise.all(drafts.map(async (d) => ({ ...view(d), stillTrue: await social.stillTrue(d) }))) };
  });

  app.post<{ Params: { id: string } }>('/admin/social/challenges/:id/review', async (req, reply) => {
    const d = await social.get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    const { action, note } = bodyOf(req);
    const text = typeof note === 'string' ? note.slice(0, 500) : undefined;
    const moves: Record<string, [string[], string]> = { approve: [['draft', 'rejected', 'revoked'], 'approved'],
      reject: [['draft', 'approved'], 'rejected'], revoke: [['approved'], 'revoked'] };
    const move = typeof action === 'string' ? moves[action] : undefined;
    if (!move) return reply.code(400).send({ error: 'bad_action' });
    if (action === 'approve' && !(await social.stillTrue(d))) return reply.code(409).send({ error: 'no_longer_true' });
    if (!(await set(d.id, move[0], move[1], text !== undefined ? { note: text } : {}))) return reply.code(409).send({ error: `cannot_${action}_from_${d.status}` });
    return view((await social.get(d.id))!);
  });

  app.post<{ Params: { id: string } }>('/admin/social/challenges/:id/publish', async (req, reply) => {
    if (!publisher) return reply.code(503).send({ error: 'x_publishing_disabled' });
    const d = await social.get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status === 'published') return view(d);
    if (d.status !== 'approved') return reply.code(409).send({ error: 'not_approved' });
    if (!(await social.stillTrue(d))) return reply.code(409).send({ error: 'no_longer_true' });
    try { await publisher.verifyAccount(); } catch { return reply.code(503).send({ error: 'x_account_verification_failed' }); }
    // The reservation comes first: only one press can move approved -> publishing.
    if (!(await set(d.id, ['approved'], 'publishing'))) return reply.code(409).send({ error: 'not_approved' });
    let postId: string | null = null;
    try {
      const post = await publisher.create(d.body);
      if (post.text === d.body && /^[0-9]{1,30}$/.test(post.id)) postId = post.id;
    } catch { /* it may have reached X: unknown, never retried */ }
    await set(d.id, ['publishing'], postId ? 'published' : 'unknown', { xPostId: postId });
    const after = view((await social.get(d.id))!);
    return reply.code(postId ? 200 : 202).send(after);
  });

  app.post<{ Params: { id: string } }>('/admin/social/challenges/:id/resolve', async (req, reply) => {
    if (!publisher) return reply.code(503).send({ error: 'x_publishing_disabled' });
    const d = await social.get(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (d.status !== 'unknown') return reply.code(409).send({ error: 'not_unknown' });
    const { xPostId, notPosted } = bodyOf(req);
    if (typeof xPostId === 'string' && /^[0-9]{1,30}$/.test(xPostId)) {
      let post;
      try { post = await publisher.lookup(xPostId); } catch { return reply.code(503).send({ error: 'x_lookup_unavailable' }); }
      if (!post || post.authorId !== publisher.accountId || post.text !== d.body) return reply.code(409).send({ error: 'post_does_not_match' });
      await set(d.id, ['unknown'], 'published', { xPostId });
    } else if (notPosted === true) {
      // The owner looked on X and the post is not there: it may be published again.
      await set(d.id, ['unknown'], 'approved');
    } else return reply.code(400).send({ error: 'say_what_you_found' });
    return view((await social.get(d.id))!);
  });
}
