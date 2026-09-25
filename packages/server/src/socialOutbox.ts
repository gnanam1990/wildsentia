import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from './db/pool.js';
import type { EventBoundary } from './db/eventStore.js';
import { xPublishPlan } from './xPublishPlan.js';
import { createXPublisher, type XPublisher } from './xPublisher.js';

export interface SocialConfig { adminToken: string; xPublisher?: XPublisher }
export function socialConfig(env: NodeJS.ProcessEnv): SocialConfig | undefined {
  const token = env.VANA_SOCIAL_ADMIN_TOKEN;
  if (token === undefined) return undefined;
  if (token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error('Invalid social admin token');
  if (env.VANA_X_PUBLISH_ENABLED !== undefined && !['0', '1'].includes(env.VANA_X_PUBLISH_ENABLED))
    throw new Error('Invalid X publishing flag');
  if (env.VANA_X_PUBLISH_ENABLED !== '1') return { adminToken: token };
  if (!env.VANA_X_ACCOUNT_ID || !env.VANA_X_USER_ACCESS_TOKEN)
    throw new Error('X publishing requires account ID and user access token');
  return { adminToken: token, xPublisher: createXPublisher(env.VANA_X_ACCOUNT_ID, env.VANA_X_USER_ACCESS_TOKEN) };
}
export const SOCIAL_EVENT_TYPES = ['born', 'died', 'hunt', 'human_born', 'human_died', 'human_hunt', 'building_rebuilt'] as const;
type EligibleType = typeof SOCIAL_EVENT_TYPES[number];
const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const bodyOf = (request: FastifyRequest): Record<string, unknown> => typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
  ? request.body as Record<string, unknown> : {};
const bearer = (request: FastifyRequest): string => request.headers.authorization?.match(/^Bearer ([^\s]{1,256})$/)?.[1] ?? '';
interface SourceEvent { id: string; type: EligibleType; world_time: string; patch_id: number; outcome: string; confidence: string;
  conditions: Record<string, unknown>; source_fingerprint?: string }
interface Draft { id: string; seq: string; event_id: string; event_type: string; source_world_time: string; body: string;
  source_patch_id: number; source_outcome: string; source_conditions: Record<string, unknown>; source_fingerprint: string;
  status: 'draft' | 'approved' | 'rejected' | 'revoked'; created_at: Date; reviewed_at: Date | null }
interface XPublication { draft_id: string; plan_fingerprint: string; source_fingerprint: string; account_id: string;
  status: 'sending' | 'unknown' | 'published'; x_post_id: string | null; created_at: Date; resolved_at: Date | null }
const publicationView = (row: XPublication) => ({ draftId: row.draft_id, fingerprint: row.plan_fingerprint,
  accountId: row.account_id, status: row.status === 'sending' ? 'unknown' : row.status,
  published: row.status === 'published', xPostId: row.x_post_id,
  createdAt: row.created_at, resolvedAt: row.resolved_at });
const publicDraft = (row: Draft) => ({ id: row.id, eventId: row.event_id, eventType: row.event_type,
  sourceWorldTime: Number(row.source_world_time), body: row.body, status: row.status,
  createdAt: row.created_at, reviewedAt: row.reviewed_at });
const boundarySql = (time: number, sequence: number): string =>
  `e.world_time < $${time} or (e.world_time = $${time} and e.event_sequence < $${sequence})`;
const sourceMatch = `e.id=d.event_id and e.type=d.event_type and e.world_time=d.source_world_time
  and e.patch_id=d.source_patch_id and e.outcome=d.source_outcome and e.conditions=d.source_conditions
  and d.source_fingerprint=md5((to_jsonb(e)-'recorded_at')::text)`;
const pageCursor = (value: unknown): string | null | undefined => {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return undefined;
  return BigInt(value) <= 9_223_372_036_854_775_807n ? value : undefined;
};
function candidateCursor(value: unknown): { worldTime: number; id: string } | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') return undefined;
    const { worldTime, id } = decoded as { worldTime?: unknown; id?: unknown };
    return Number.isSafeInteger(worldTime) && (worldTime as number) >= 0
      && typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
      ? { worldTime: worldTime as number, id } : undefined;
  } catch { return undefined; }
}

/** Only template facts present in a committed event. No model, recipient data, or simulation command. */
export function socialDraftText(event: SourceEvent): string | null {
  if (!SOCIAL_EVENT_TYPES.includes(event.type) || event.confidence !== 'authoritative') return null;
  if (!Number.isSafeInteger(Number(event.world_time)) || Number(event.world_time) < 0) return null;
  if (!['success', 'failure', 'abandoned', 'interrupted'].includes(event.outcome)) return null;
  const day = Math.floor(Number(event.world_time) / 86_400) + 1;
  const hour = Math.floor(Number(event.world_time) % 86_400 / 3_600);
  const clock = `Vana day ${day}, hour ${hour}`;
  const rawSpecies = event.conditions.species;
  const species = typeof rawSpecies === 'string' && /^[a-z][a-z0-9_]{0,30}$/.test(rawSpecies)
    ? rawSpecies.replaceAll('_', ' ') : null;
  const animal = species ? `${/^[aeiou]/.test(species) ? 'an' : 'a'} ${species}` : 'an animal';
  const line: Record<EligibleType, string> = {
    born: `${animal[0]!.toUpperCase()}${animal.slice(1)} was born in the forest.`,
    died: `${animal[0]!.toUpperCase()}${animal.slice(1)} died in the forest.`,
    hunt: event.outcome === 'success' ? 'A predator hunt succeeded.' : 'A predator hunt ended without a kill.',
    human_born: 'A child was born in the fictional village.',
    human_died: 'A person died in the fictional village.',
    human_hunt: event.outcome === 'success' ? 'A village hunt succeeded.' : 'A village hunt ended without a catch.',
    building_rebuilt: 'The fictional village completed a home rebuild.',
  };
  if (event.type !== 'hunt' && event.type !== 'human_hunt' && event.outcome !== 'success') return null;
  const text = `${clock}: ${line[event.type]} Recorded simulation event; not a live alert.`;
  return text.length <= 280 ? text : null;
}

/** A matching event row alone does not make a subsequently edited draft body grounded. */
function validDraftBody(draft: Draft): boolean {
  return draft.body === socialDraftText({ id: draft.event_id, type: draft.event_type as EligibleType,
    world_time: draft.source_world_time, patch_id: draft.source_patch_id, outcome: draft.source_outcome,
    conditions: draft.source_conditions, confidence: 'authoritative' });
}

export function installSocialOutbox(app: FastifyInstance, deps: {
  pool: Pool; config?: SocialConfig | undefined; boundary: () => EventBoundary | null;
}): void {
  const { pool, config, boundary } = deps;
  const limits = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (!/^\/admin\/social(?:[/?]|$)/.test(request.url)) return;
    reply.header('Cache-Control', 'no-store'); reply.header('Referrer-Policy', 'no-referrer');
    if (!config) return reply.code(503).send({ error: 'social_outbox_not_configured' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'same_origin_required' });
    const now = Date.now(), key = request.ip;
    for (const [ip, window] of limits) if (window.until <= now) limits.delete(ip);
    const window = limits.get(key) ?? { count: 0, until: now + 60_000 };
    if ((!limits.has(key) && limits.size >= 5000) || ++window.count > 120)
      return reply.code(429).send({ error: 'rate_limited' });
    limits.set(key, window);
    // Count rejected admin attempts too; otherwise guesses evade the per-IP cap.
    if (!timingSafeEqual(hash(bearer(request)), hash(config.adminToken)))
      return reply.code(401).send({ error: 'social_admin_auth_required' });
    if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json'))
      return reply.code(415).send({ error: 'json_required' });
  });
  const committed = () => boundary();

  app.get<{ Querystring: { cursor?: string } }>('/admin/social/candidates', async (request, reply) => {
    const before = candidateCursor(request.query.cursor);
    if (before === undefined) return reply.code(400).send({ error: 'invalid_page_cursor' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const { rows } = await pool.query<SourceEvent & { drafted: boolean }>(`select e.id,e.type,e.world_time,e.patch_id,e.outcome,e.confidence,e.conditions,
      (d.id is not null) as drafted from events e left join social_drafts d on ${sourceMatch}
      where (${boundarySql(2, 3)}) and e.type = any($1::text[]) and e.confidence='authoritative'
      and e.world_time >= 0 and e.outcome in ('success','failure','abandoned','interrupted')
      and (e.type in ('hunt','human_hunt') or e.outcome='success')
      and ($4::bigint is null or (e.world_time,e.id collate "C") < ($4::bigint,$5::text collate "C"))
      order by e.world_time desc,e.id collate "C" desc limit 101`,
    [SOCIAL_EVENT_TYPES, view.worldTime, view.nextSequence, before?.worldTime ?? null, before?.id ?? null]);
    const items = rows.slice(0, 100), last = items.at(-1);
    return { source: 'committed_events', asOfWorldTime: view.worldTime,
      candidates: items.filter((e) => socialDraftText(e) !== null).map((e) => ({ eventId: e.id, type: e.type,
        worldTime: Number(e.world_time), patchId: e.patch_id, outcome: e.outcome, drafted: e.drafted })),
      next: rows.length > 100 && last ? Buffer.from(JSON.stringify({ worldTime: Number(last.world_time), id: last.id })).toString('base64url') : null };
  });

  app.post('/admin/social/drafts', { bodyLimit: 1024 }, async (request, reply) => {
    const eventId = bodyOf(request).eventId;
    if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(eventId))
      return reply.code(400).send({ error: 'invalid_event_id' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const db = await pool.connect();
    try {
      await db.query('begin');
      const event = (await db.query<SourceEvent>(`select e.id,e.type,e.world_time,e.patch_id,e.outcome,e.confidence,e.conditions,
        md5((to_jsonb(e)-'recorded_at')::text) as source_fingerprint
        from events e where e.id=$1 and (${boundarySql(2, 3)}) and e.type=any($4::text[]) for share of e`,
      [eventId, view.worldTime, view.nextSequence, SOCIAL_EVENT_TYPES])).rows[0];
      const body = event ? socialDraftText(event) : null;
      if (!event || !body) { await db.query('rollback'); return reply.code(404).send({ error: 'committed_eligible_event_not_found' }); }
      const created = await db.query<{ id: string }>(`insert into social_drafts
        (id,event_id,event_type,source_world_time,source_patch_id,source_outcome,source_conditions,source_fingerprint,body)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) on conflict (event_id) do nothing returning id`,
      [randomUUID(), event.id, event.type, event.world_time, event.patch_id, event.outcome,
        JSON.stringify(event.conditions), event.source_fingerprint, body]);
      const draft = (await db.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
        where e.id=$1`, [event.id])).rows[0];
      if (!draft || !validDraftBody(draft)) {
        await db.query('rollback'); return reply.code(409).send({ error: 'source_or_draft_changed_reconcile_before_redraft' });
      }
      if (created.rowCount) await db.query("insert into social_audit(draft_id,action,note) values ($1,'generated','Template from committed authoritative event')", [draft.id]);
      await db.query('commit'); return { ...publicDraft(draft), reused: !created.rowCount };
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'draft_unavailable_retry_same_event' }); }
    finally { db.release(); }
  });

  app.get<{ Querystring: { cursor?: string } }>('/admin/social/drafts', async (request, reply) => {
    const cursor = pageCursor(request.query.cursor);
    if (cursor === undefined) return reply.code(400).send({ error: 'invalid_page_cursor' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const { rows } = await pool.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
      where (${boundarySql(1, 2)}) and e.confidence='authoritative'
      and ($3::bigint is null or d.seq < $3::bigint)
      order by d.seq desc limit 101`, [view.worldTime, view.nextSequence, cursor]);
    const pageRows = rows.slice(0, 100), items = pageRows.filter(validDraftBody);
    return { drafts: items.map(publicDraft), next: rows.length > 100 ? pageRows.at(-1)!.seq : null,
      notice: 'Private drafts only; no external publication is configured.' };
  });

  app.post('/admin/social/review', { bodyLimit: 1024 }, async (request, reply) => {
    const input = bodyOf(request), action = input.action;
    if (!uuid(input.draftId) || !['approve', 'reject', 'revoke'].includes(String(action))
      || typeof input.note !== 'string' || input.note.trim().length < 5 || input.note.length > 240)
      return reply.code(400).send({ error: 'invalid_review_or_note' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const db = await pool.connect();
    try {
      await db.query('begin');
      const draft = (await db.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
        where d.id=$1 and (${boundarySql(2, 3)}) and e.confidence='authoritative' for update of d`,
      [input.draftId, view.worldTime, view.nextSequence])).rows[0];
      if (!draft) { await db.query('rollback'); return reply.code(404).send({ error: 'committed_draft_not_found' }); }
      if (!validDraftBody(draft)) {
        await db.query('rollback'); return reply.code(409).send({ error: 'draft_text_changed_reconcile_before_review' });
      }
      if (action === 'revoke' ? draft.status !== 'approved' : draft.status !== 'draft') {
        await db.query('rollback'); return reply.code(409).send({ error: 'review_state_changed' });
      }
      if (action === 'revoke' && (await db.query('select 1 from x_publications where draft_id=$1', [draft.id])).rowCount) {
        await db.query('rollback'); return reply.code(409).send({ error: 'x_attempt_requires_reconciliation' });
      }
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked';
      await db.query('update social_drafts set status=$1,reviewed_at=now() where id=$2', [status, draft.id]);
      await db.query('insert into social_audit(draft_id,action,note) values ($1,$2,$3)', [draft.id,
        action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revoked', input.note.trim()]);
      await db.query('commit'); return { id: draft.id, status, published: false };
    } catch { await db.query('rollback'); return reply.code(503).send({ error: 'review_unavailable_refresh' }); }
    finally { db.release(); }
  });

  app.get<{ Querystring: { cursor?: string } }>('/admin/social/export', async (request, reply) => {
    const cursor = pageCursor(request.query.cursor);
    if (cursor === undefined) return reply.code(400).send({ error: 'invalid_page_cursor' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const { rows } = await pool.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
      where d.status='approved' and (${boundarySql(1, 2)}) and e.confidence='authoritative'
      and ($3::bigint is null or d.seq < $3::bigint)
      order by d.seq desc limit 101`, [view.worldTime, view.nextSequence, cursor]);
    const pageRows = rows.slice(0, 100), items = pageRows.filter(validDraftBody);
    const next = rows.length > 100 ? pageRows.at(-1)!.seq : null;
    if (items.length) {
      // This records a successful retrieval attempt, not a download, copy or external post.
      // A stable response key coalesces retries while retaining a count and last-fetch time.
      const fingerprint = createHash('sha256').update(JSON.stringify({ cursor, view, next,
        source: items.map((draft) => [draft.id, draft.seq, draft.source_fingerprint]) })).digest('hex');
      try {
        await pool.query(`insert into social_export_audit
          (response_fingerprint,source_world_time,source_next_sequence,requested_cursor,next_cursor,draft_ids,item_count)
          values ($1,$2,$3,$4,$5,$6::uuid[],$7)
          on conflict (response_fingerprint) do update set
            fetch_count=social_export_audit.fetch_count+1,last_fetched_at=now()`,
        [fingerprint, view.worldTime, view.nextSequence, cursor, next, items.map((draft) => draft.id), items.length]);
      } catch { return reply.code(503).send({ error: 'export_audit_unavailable' }); }
    }
    return { format: 'manual_dry_run_only', published: false, items: items.map(publicDraft),
      next,
      notice: 'Copy only after independent editorial review. This endpoint does not post to X or any other service.' };
  });

  app.get('/admin/social/x-config', async () => ({
    enabled: Boolean(config?.xPublisher), accountId: config?.xPublisher?.accountId ?? null,
  }));

  // Credential-free preparation remains a dry run even when publishing is configured.
  app.post('/admin/social/x-prepare', { bodyLimit: 1024 }, async (request, reply) => {
    const draftId = bodyOf(request).draftId;
    if (!uuid(draftId)) return reply.code(400).send({ error: 'invalid_draft_id' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const { rows } = await pool.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
      where d.id=$1 and d.status='approved' and (${boundarySql(2, 3)})
      and e.confidence='authoritative'`, [draftId, view.worldTime, view.nextSequence]);
    const draft = rows[0];
    if (!draft || !validDraftBody(draft))
      return reply.code(404).send({ error: 'approved_grounded_draft_not_found' });
    if ((await pool.query('select 1 from x_publications where draft_id=$1', [draftId])).rowCount)
      return reply.code(409).send({ error: 'x_attempt_already_reserved_check_status' });
    return xPublishPlan({ draftId: draft.id, sourceFingerprint: draft.source_fingerprint, text: draft.body });
  });

  // A durable one-shot reservation precedes the external call. Any ambiguous result stays UNKNOWN.
  app.post('/admin/social/x-publish', { bodyLimit: 1024 }, async (request, reply) => {
    const draftId = bodyOf(request).draftId;
    if (!uuid(draftId)) return reply.code(400).send({ error: 'invalid_draft_id' });
    const publisher = config?.xPublisher;
    if (!publisher) return reply.code(503).send({ error: 'x_publishing_disabled' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    try { await publisher.verifyAccount(); }
    catch { return reply.code(503).send({ error: 'x_account_verification_failed' }); }
    const db = await pool.connect();
    let draft: Draft;
    let plan: ReturnType<typeof xPublishPlan>;
    try {
      await db.query('begin');
      const found = (await db.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
        where d.id=$1 and d.status='approved' and (${boundarySql(2, 3)})
        and e.confidence='authoritative' for update of d`, [draftId, view.worldTime, view.nextSequence])).rows[0];
      if (!found || !validDraftBody(found)) {
        await db.query('rollback'); return reply.code(404).send({ error: 'approved_grounded_draft_not_found' });
      }
      draft = found;
      plan = xPublishPlan({ draftId: draft.id, sourceFingerprint: draft.source_fingerprint, text: draft.body });
      const inserted = await db.query(`insert into x_publications
        (draft_id,plan_fingerprint,source_fingerprint,account_id,status) values ($1,$2,$3,$4,'sending')
        on conflict (draft_id) do nothing returning draft_id`,
      [draft.id, plan.fingerprint, draft.source_fingerprint, publisher.accountId]);
      if (!inserted.rowCount) {
        const prior = (await db.query<XPublication>('select * from x_publications where draft_id=$1', [draft.id])).rows[0]!;
        await db.query('commit');
        return reply.code(prior.status === 'published' ? 200 : 202).send(publicationView(prior));
      }
      await db.query("insert into x_publication_audit(draft_id,action) values ($1,'reserved')", [draft.id]);
      await db.query('commit');
    } catch {
      await db.query('rollback'); return reply.code(503).send({ error: 'x_reservation_unavailable' });
    } finally { db.release(); }

    // This is the only create call. A timeout, invalid response, or DB failure cannot trigger another.
    let xPostId: string | null = null;
    try {
      const post = await publisher.create(plan.request.body.text);
      if (post.text !== plan.request.body.text || !/^[0-9]{1,30}$/.test(post.id)) throw new Error('X response mismatch');
      xPostId = post.id;
    } catch { /* The request may have reached X. Reconcile; never retry. */ }
    const resultDb = await pool.connect().catch(() => null);
    if (!resultDb) return reply.code(503).send({ error: 'x_result_reconciliation_required' });
    try {
      await resultDb.query('begin');
      const result = await resultDb.query<XPublication>(`update x_publications set status=$2,
        x_post_id=$3,resolved_at=case when $3::text is null then null else now() end
        where draft_id=$1 and status='sending' returning *`,
      [draft.id, xPostId ? 'published' : 'unknown', xPostId]);
      if (result.rowCount) await resultDb.query(`insert into x_publication_audit(draft_id,action,x_post_id)
        values ($1,$2,$3)`, [draft.id, xPostId ? 'confirmed' : 'unknown', xPostId]);
      await resultDb.query('commit');
      if (!result.rowCount) return reply.code(503).send({ error: 'x_result_reconciliation_required' });
      return reply.code(xPostId ? 200 : 202).send(publicationView(result.rows[0]!));
    } catch { await resultDb.query('rollback'); return reply.code(503).send({ error: 'x_result_reconciliation_required' }); }
    finally { resultDb.release(); }
  });

  app.get<{ Params: { draftId: string } }>('/admin/social/x-publications/:draftId', async (request, reply) => {
    if (!uuid(request.params.draftId)) return reply.code(400).send({ error: 'invalid_draft_id' });
    const row = (await pool.query<XPublication>('select * from x_publications where draft_id=$1',
      [request.params.draftId])).rows[0];
    if (!row) return reply.code(404).send({ error: 'x_publication_not_found' });
    return publicationView(row);
  });

  app.get<{ Params: { draftId: string } }>('/admin/social/x-publications/:draftId/audit', async (request, reply) => {
    if (!uuid(request.params.draftId)) return reply.code(400).send({ error: 'invalid_draft_id' });
    const publication = (await pool.query<XPublication>('select * from x_publications where draft_id=$1',
      [request.params.draftId])).rows[0];
    if (!publication) return reply.code(404).send({ error: 'x_publication_not_found' });
    const { rows } = await pool.query<{ id: string; action: string; x_post_id: string | null; created_at: Date }>(
      'select id,action,x_post_id,created_at from x_publication_audit where draft_id=$1 order by id',
      [request.params.draftId]);
    return { draftId: publication.draft_id, entries: rows };
  });

  app.post('/admin/social/x-reconcile', { bodyLimit: 1024 }, async (request, reply) => {
    const input = bodyOf(request);
    if (!uuid(input.draftId) || typeof input.xPostId !== 'string' || !/^[0-9]{1,30}$/.test(input.xPostId))
      return reply.code(400).send({ error: 'invalid_x_reconciliation' });
    const publisher = config?.xPublisher;
    if (!publisher) return reply.code(503).send({ error: 'x_publishing_disabled' });
    const attempt = (await pool.query<XPublication>('select * from x_publications where draft_id=$1', [input.draftId])).rows[0];
    if (!attempt) return reply.code(404).send({ error: 'x_publication_not_found' });
    if (attempt.status === 'published') return attempt.x_post_id === input.xPostId
      ? publicationView(attempt) : reply.code(409).send({ error: 'x_post_id_conflict' });
    const view = committed(); if (!view) return reply.code(503).send({ error: 'checkpoint_unavailable' });
    const draft = (await pool.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
      where d.id=$1 and d.status='approved' and (${boundarySql(2, 3)}) and e.confidence='authoritative'`,
    [input.draftId, view.worldTime, view.nextSequence])).rows[0];
    if (!draft || !validDraftBody(draft) || attempt.plan_fingerprint !== xPublishPlan({
      draftId: draft.id, sourceFingerprint: draft.source_fingerprint, text: draft.body,
    }).fingerprint || attempt.account_id !== publisher.accountId)
      return reply.code(409).send({ error: 'x_source_or_account_changed' });
    let post: Awaited<ReturnType<XPublisher['lookup']>>;
    try { post = await publisher.lookup(input.xPostId); }
    catch { return reply.code(503).send({ error: 'x_lookup_unavailable' }); }
    const postText = xPublishPlan({ draftId: draft.id, sourceFingerprint: draft.source_fingerprint,
      text: draft.body }).request.body.text;
    if (!post || post.id !== input.xPostId || post.authorId !== attempt.account_id || post.text !== postText)
      return reply.code(409).send({ error: 'x_post_not_verified' });
    try {
      const db = await pool.connect();
      try {
        await db.query('begin');
        const current = (await db.query<Draft>(`select d.* from social_drafts d join events e on ${sourceMatch}
          where d.id=$1 and d.status='approved' and (${boundarySql(2, 3)})
          and e.confidence='authoritative' for update of d,e`,
        [draft.id, view.worldTime, view.nextSequence])).rows[0];
        if (!current || !validDraftBody(current) ||
          xPublishPlan({ draftId: current.id, sourceFingerprint: current.source_fingerprint,
            text: current.body }).fingerprint !== attempt.plan_fingerprint ||
          xPublishPlan({ draftId: current.id, sourceFingerprint: current.source_fingerprint,
            text: current.body }).request.body.text !== post.text) {
          await db.query('rollback'); return reply.code(409).send({ error: 'x_source_changed_during_reconciliation' });
        }
        const updated = (await db.query<XPublication>(`update x_publications set status='published',x_post_id=$2,resolved_at=now()
          where draft_id=$1 and status in ('sending','unknown') returning *`, [draft.id, post.id])).rows[0];
        if (updated) await db.query("insert into x_publication_audit(draft_id,action,x_post_id) values ($1,'reconciled',$2)",
          [draft.id, post.id]);
        await db.query('commit');
        return publicationView(updated ?? (await pool.query<XPublication>(
          'select * from x_publications where draft_id=$1', [draft.id])).rows[0]!);
      } catch (error) { await db.query('rollback'); throw error; }
      finally { db.release(); }
    } catch { return reply.code(503).send({ error: 'x_reconciliation_unavailable' }); }
  });

  app.get<{ Querystring: { cursor?: string } }>('/admin/social/export-audit', async (request, reply) => {
    const cursor = pageCursor(request.query.cursor);
    if (cursor === undefined) return reply.code(400).send({ error: 'invalid_page_cursor' });
    const { rows } = await pool.query<{ id: string; response_fingerprint: string; source_world_time: string;
      source_next_sequence: string; requested_cursor: string | null; next_cursor: string | null;
      draft_ids: string[]; item_count: number; first_fetched_at: Date; last_fetched_at: Date; fetch_count: string }>(
      'select * from social_export_audit where ($1::bigint is null or id < $1::bigint) order by id desc limit 101', [cursor]);
    const items = rows.slice(0, 100);
    return { entries: items, next: rows.length > 100 ? items.at(-1)!.id : null };
  });

  app.get<{ Querystring: { cursor?: string } }>('/admin/social/audit', async (request, reply) => {
    const cursor = pageCursor(request.query.cursor);
    if (cursor === undefined) return reply.code(400).send({ error: 'invalid_page_cursor' });
    const { rows } = await pool.query<{ id: string; draft_id: string; action: string; note: string; created_at: Date }>(
      'select * from social_audit where ($1::bigint is null or id < $1::bigint) order by id desc limit 101', [cursor]);
    const items = rows.slice(0, 100);
    return { entries: items, next: rows.length > 100 ? items.at(-1)!.id : null };
  });
}
