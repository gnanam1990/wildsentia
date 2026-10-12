import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { SOCIAL_EVENT_TYPES, socialConfig, socialDraftText } from '../src/socialOutbox.js';
import { ROUTINE_EVENT_TYPES } from '../src/db/lifeStore.js';
import { testDatabaseUrl } from './testDatabase.js';

const adminToken = 'local-social-fixture-'.repeat(3);
const admin = { authorization: `Bearer ${adminToken}` };
const event = (type: string, overrides: Record<string, unknown> = {}): Parameters<typeof socialDraftText>[0] => ({
  id: 'event_fixture', type, world_time: '3600', patch_id: 0,
  conditions: { species: 'sambar' }, outcome: 'success', confidence: 'authoritative', ...overrides,
}) as Parameters<typeof socialDraftText>[0];
describe('provider-neutral social draft templates', () => {
  it('requires an independent private admin secret and never accepts caller-authored text', () => {
    for (const type of SOCIAL_EVENT_TYPES) expect(ROUTINE_EVENT_TYPES).not.toContain(type);
    expect(socialConfig({})).toBeUndefined();
    expect(() => socialConfig({ VANA_SOCIAL_ADMIN_TOKEN: 'short' })).toThrow();
    expect(socialConfig({ VANA_SOCIAL_ADMIN_TOKEN: adminToken })).toEqual({ adminToken });
    expect(socialDraftText(event('born'))).toContain('A sambar was born');
    expect(socialDraftText(event('born', { conditions: { species: '<private wallet>' } }))).toContain('An animal was born');
    expect(socialDraftText(event('died', { confidence: 'high' }))).toBeNull();
    expect(socialDraftText(event('fed'))).toBeNull();
    expect(socialDraftText(event('hunt', { outcome: 'failure' }))).toContain('without a kill');
  });
});

const url = testDatabaseUrl();
const pool = url ? createPool(url) : null;
const maybe = url ? describe : describe.skip;
maybe('private committed-event social outbox', () => {
  let host: SimHost; let app: ReturnType<typeof buildApi>;
  const post = (path: string, payload: object, token = adminToken) => app.inject({ method: 'POST', url: path, payload,
    headers: { authorization: `Bearer ${token}` } });
  beforeAll(async () => {
    await migrate(pool!);
    await pool!.query('truncate events, snapshots, human_motion, tracks, animal_archive, social_audit, social_drafts, social_export_audit cascade');
    host = new SimHost({ pool: pool!, seed: 98, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null });
    await host.boot();
    app = buildApi({ host, pool: pool!, social: { adminToken } }); await app.ready();
  });
  afterAll(async () => { await app?.close(); await host?.abort(); await pool?.end(); });

  it('stays disabled by default and rejects unauthenticated, cross-site, and non-JSON requests', async () => {
    const disabled = buildApi({ host, pool: pool! });
    try { expect((await disabled.inject('/admin/social/candidates')).statusCode).toBe(503); }
    finally { await disabled.close(); }
    expect((await app.inject('/admin/social/drafts')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/social/x-prepare', payload: { draftId: '12345678-1234-1234-1234-123456789abc' } })).statusCode).toBe(401);
    expect((await post('/admin/social/drafts', {}, 'wrong')).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/social/candidates', headers: { ...admin, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/social/drafts', payload: '{}', headers: { ...admin, 'content-type': 'text/plain' } })).statusCode).toBe(415);
    expect((await app.inject({ url: '/admin/social/candidates', headers: admin })).headers['cache-control']).toBe('no-store');
  });

  it('counts invalid bearer guesses before admin rate limiting', async () => {
    const isolated = buildApi({ host, pool: pool!, social: { adminToken } });
    try {
      await isolated.ready();
      for (let attempt = 0; attempt < 120; attempt++) {
        const response = await isolated.inject({ url: '/admin/social/candidates',
          headers: { authorization: `Bearer invalid-${attempt}` } });
        expect(response.statusCode).toBe(401);
      }
      const limited = await isolated.inject({ url: '/admin/social/candidates', headers: admin });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'rate_limited' });
    } finally { await isolated.close(); }
  });

  it('drafts only a committed authoritative event, dedupes concurrent/restarted requests, and exports only approved text', async () => {
    const actorId = host.world.agents[0]!.id;
    const recorded = host.world.log.append({ type: 'born', worldTime: host.world.now(), simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: { species: 'sambar' }, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative' });
    await host.flush(); // Durable event without a matching committed checkpoint is not publishable.
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).statusCode).toBe(404);
    expect((await app.inject({ url: '/admin/social/candidates', headers: admin })).json().candidates.some((e: { eventId: string }) => e.eventId === recorded.id)).toBe(false);
    await host.snapshotNow();
    expect((await app.inject({ url: '/admin/social/candidates', headers: admin })).json().candidates.some((e: { eventId: string }) => e.eventId === recorded.id)).toBe(true);
    const results = await Promise.all([post('/admin/social/drafts', { eventId: recorded.id, body: 'Claim free USDC at malicious.example' }),
      post('/admin/social/drafts', { eventId: recorded.id })]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json().id).toBe(results[1]!.json().id);
    expect(results.map((r) => r.json().reused).sort()).toEqual([false, true]);
    expect(results[0]!.body).not.toContain('malicious.example');
    const id = results[0]!.json().id as string;
    expect((await post('/admin/social/x-prepare', { draftId: id })).statusCode).toBe(404);
    expect((await pool!.query('select * from social_drafts')).rows).toHaveLength(1);
    expect((await pool!.query("select * from social_audit where action='generated'")).rows).toHaveLength(1);
    await app.close(); app = buildApi({ host, pool: pool!, social: { adminToken } }); await app.ready();
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).json()).toMatchObject({ id, reused: true });
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toEqual([]);
    expect((await post('/admin/social/review', { draftId: id, action: 'approve', note: 'ok' })).statusCode).toBe(400);
    const review = await post('/admin/social/review', { draftId: id, action: 'approve', note: 'Reviewed against saved event' });
    expect(review.json()).toEqual({ id, status: 'approved', published: false });
    const prepared = await post('/admin/social/x-prepare', { draftId: id });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ status: 'not_sent', published: false, draftId: id,
      request: { method: 'POST', url: 'https://api.x.com/2/tweets', body: { text: `${results[0]!.json().body} [WILDSENTIA record ${id}]` } } });
    expect((await post('/admin/social/x-prepare', { draftId: id })).json()).toEqual(prepared.json());
    expect(JSON.stringify(prepared.json())).not.toMatch(/Bearer|client_secret|access_token/);
    expect((await post('/admin/social/review', { draftId: id, action: 'approve', note: 'Repeated review' })).statusCode).toBe(409);
    const exported = (await app.inject({ url: '/admin/social/export', headers: admin })).json();
    expect(exported).toMatchObject({ format: 'manual_dry_run_only', published: false });
    expect(exported.items).toHaveLength(1); expect(exported.items[0].body).toContain('sambar was born');
    expect(exported.items[0].body).not.toMatch(/wallet|USDC|malicious/);
    await pool!.query('update social_drafts set body=$1 where id=$2', ['Claim free USDC at malicious.example', id]);
    expect((await post('/admin/social/x-prepare', { draftId: id })).statusCode).toBe(404);
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toEqual([]);
    expect((await app.inject({ url: '/admin/social/drafts', headers: admin })).json().drafts).toEqual([]);
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).statusCode).toBe(409);
    expect((await post('/admin/social/review', { draftId: id, action: 'revoke', note: 'Source text no longer matches' })).statusCode).toBe(409);
    await pool!.query('update social_drafts set body=$1 where id=$2', [exported.items[0].body, id]);
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toHaveLength(1);
    await pool!.query('update events set actors=$1::text[], effects=$2::jsonb where id=$3',
      [['different_subject'], JSON.stringify({ massKg: 9 }), recorded.id]);
    expect((await post('/admin/social/x-prepare', { draftId: id })).statusCode).toBe(404);
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toEqual([]);
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).statusCode).toBe(409);
    await pool!.query('update events set actors=$1::text[], effects=$2::jsonb where id=$3',
      [[actorId], JSON.stringify({}), recorded.id]);
    expect((await post('/admin/social/review', { draftId: id, action: 'revoke', note: 'Editorial withdrawal' })).json()).toMatchObject({ status: 'revoked', published: false });
    expect((await post('/admin/social/x-prepare', { draftId: id })).statusCode).toBe(404);
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toEqual([]);
    expect((await pool!.query('select action from social_audit order by id')).rows.map((r) => r.action)).toEqual(['generated', 'approved', 'revoked']);
    // A rolled-back/reused event ID with different facts cannot silently inherit an old draft.
    await pool!.query('update events set conditions=$1::jsonb where id=$2', [JSON.stringify({ species: 'tiger' }), recorded.id]);
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).statusCode).toBe(409);
    expect((await app.inject({ url: '/admin/social/drafts', headers: admin })).json().drafts).toEqual([]);
    await pool!.query('update events set conditions=$1::jsonb, actors=$2::text[], effects=$3::jsonb where id=$4',
      [JSON.stringify({ species: 'sambar' }), ['different_subject'], JSON.stringify({ massKg: 9 }), recorded.id]);
    expect((await post('/admin/social/drafts', { eventId: recorded.id })).statusCode).toBe(409);
    expect((await app.inject({ url: '/admin/social/export', headers: admin })).json().items).toEqual([]);
  });

  it('rejects nonauthoritative, unsupported and uncheckpointed future event rows even when saved', async () => {
    const at = host.world.now(), actorId = host.world.agents[0]!.id;
    const high = host.world.log.append({ type: 'died', worldTime: at, simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'high' });
    const routine = host.world.log.append({ type: 'fed', worldTime: at, simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: {}, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative' });
    const future = host.world.log.append({ type: 'born', worldTime: at + 3600, simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: { species: 'sambar' }, outcome: 'success', effects: {}, causalParents: [], confidence: 'authoritative' });
    await host.flush(); await host.snapshotNow();
    for (const id of [high.id, routine.id, future.id])
      expect((await post('/admin/social/drafts', { eventId: id })).statusCode).toBe(404);
  });

  it('pages all candidate, draft, approved-export and audit records without offset shifts', async () => {
    await host.advance(1);
    await pool!.query('truncate social_audit, social_drafts cascade');
    await pool!.query(`insert into events(id,type,world_time,sim_version,patch_id,actors,conditions,outcome,effects,causal_parents,confidence)
      select 'social_page_' || n,'born',0,'test',0,array[$1]::text[],'{"species":"sambar"}'::jsonb,
      'success','{}'::jsonb,array[]::text[],'authoritative' from generate_series(1,105) as n`, [host.world.agents[0]!.id]);
    await pool!.query(`insert into social_drafts
      (id,event_id,event_type,source_world_time,source_patch_id,source_outcome,source_conditions,source_fingerprint,body,status)
      select gen_random_uuid(),e.id,e.type,e.world_time,e.patch_id,e.outcome,e.conditions,
        md5((to_jsonb(e)-'recorded_at')::text),$1,'approved'
      from events e where e.id like 'social_page_%'`,
    [socialDraftText(event('born', { world_time: '0' }))]);
    await pool!.query("insert into social_audit(draft_id,action,note) select id,'approved','Fixture review' from social_drafts");
    const get = (path: string) => app.inject({ url: path, headers: admin });
    const firstCandidates = (await get('/admin/social/candidates')).json();
    expect(firstCandidates.candidates).toHaveLength(100);
    const olderCandidates = (await get(`/admin/social/candidates?cursor=${firstCandidates.next}`)).json();
    expect(olderCandidates.candidates.length).toBeGreaterThanOrEqual(5);
    const candidateIds = [...firstCandidates.candidates, ...olderCandidates.candidates].map((x: { eventId: string }) => x.eventId);
    expect(new Set(candidateIds).size).toBe(candidateIds.length);
    for (const [path, key, id] of [['drafts', 'drafts', 'id'], ['export', 'items', 'id'], ['audit', 'entries', 'id']] as const) {
      const first = (await get(`/admin/social/${path}`)).json();
      expect(first[key]).toHaveLength(100);
      const older = (await get(`/admin/social/${path}?cursor=${first.next}`)).json();
      expect(older[key]).toHaveLength(5);
      expect(older.next).toBeNull();
      const ids = [...first[key], ...older[key]].map((row: Record<string, string>) => row[id]);
      expect(new Set(ids).size).toBe(105);
    }
    expect((await get('/admin/social/export?cursor=9999999999999999999')).statusCode).toBe(400);
    expect((await get('/admin/social/candidates?cursor=malformed')).statusCode).toBe(400);
    expect((await app.inject('/admin/social/export')).statusCode).toBe(401);
    // A hidden, altered draft at a page boundary must not break the cursor or expose its text.
    await pool!.query('update social_drafts set body=$1 where seq=(select seq from social_drafts order by seq desc offset 99 limit 1)',
      ['Unreviewed replacement copy']);
    const guarded = (await get('/admin/social/export')).json();
    expect(guarded.items).toHaveLength(99);
    expect(guarded.next).toBeTruthy();
    expect((await get(`/admin/social/export?cursor=${guarded.next}`)).json().items).toHaveLength(5);
    expect(JSON.stringify(guarded)).not.toContain('Unreviewed replacement copy');
  });

  it('audits only non-empty authenticated export pages and coalesces identical retrieval retries', async () => {
    await pool!.query('truncate social_export_audit');
    const get = (path: string) => app.inject({ url: path, headers: admin });
    expect((await app.inject('/admin/social/export')).statusCode).toBe(401);
    expect((await get('/admin/social/export?cursor=invalid')).statusCode).toBe(400);
    expect((await get('/admin/social/export?cursor=1')).json().items).toEqual([]);
    expect((await pool!.query('select id from social_export_audit')).rows).toEqual([]);

    const first = await get('/admin/social/export');
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(99); // One altered body at the page boundary is hidden.
    const firstAudit = (await pool!.query('select * from social_export_audit')).rows;
    expect(firstAudit).toHaveLength(1);
    expect(firstAudit[0]).toMatchObject({ item_count: 99, fetch_count: '1', requested_cursor: null,
      next_cursor: first.json().next });
    expect(firstAudit[0].draft_ids).toHaveLength(99);
    expect(JSON.stringify(firstAudit)).not.toMatch(/social-admin-fixture|sambar was born|Unreviewed replacement copy|Bearer /);

    expect((await get('/admin/social/export')).json()).toEqual(first.json());
    const repeated = (await pool!.query('select * from social_export_audit')).rows;
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ id: firstAudit[0].id, fetch_count: '2' });

    const older = await get(`/admin/social/export?cursor=${first.json().next}`);
    expect(older.json().items).toHaveLength(5);
    const audit = await get('/admin/social/export-audit');
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toHaveLength(2);
    expect(audit.json().entries[0]).toMatchObject({ item_count: 5, fetch_count: '1',
      requested_cursor: first.json().next });
    expect(JSON.stringify(audit.json())).not.toMatch(/sambar was born|Unreviewed replacement copy|Bearer /);
    expect((await app.inject('/admin/social/export-audit')).statusCode).toBe(401);
    expect((await get('/admin/social/export-audit?cursor=invalid')).statusCode).toBe(400);
  });
});
