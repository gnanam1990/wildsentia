import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { SimHost } from '../src/simHost.js';
import { buildApi } from '../src/api.js';
import { socialConfig } from '../src/socialOutbox.js';
import type { XPublisher } from '../src/xPublisher.js';
import { testDatabaseUrl } from './testDatabase.js';

const testUrl = testDatabaseUrl();
const maybe = testUrl ? describe : describe.skip;
maybe('X publication reservation and reconciliation', () => {
  const pool = createPool(testUrl!);
  const adminToken = 'x-publication-fixture-'.repeat(3);
  const headers = { authorization: `Bearer ${adminToken}` };
  let host: SimHost;
  let app: ReturnType<typeof buildApi>;
  let draftId: string;
  let body: string;
  let outbound: string;
  const create = vi.fn<XPublisher['create']>();
  const lookup = vi.fn<XPublisher['lookup']>();
  const verifyAccount = vi.fn<XPublisher['verifyAccount']>(async () => undefined);
  const publisher: XPublisher = { accountId: '456', verifyAccount, create, lookup };
  const post = (path: string, payload: object) => app.inject({ method: 'POST', url: path, payload, headers });

  beforeAll(async () => {
    await migrate(pool);
    await pool.query('truncate events, snapshots, human_motion, tracks, animal_archive cascade');
    await pool.query('truncate social_drafts cascade');
    host = new SimHost({ pool, seed: 121, speciesDir: fileURLToPath(new URL('../../../config/species', import.meta.url)),
      initialAgents: { sambar: 2 }, minPopulation: {}, landscape: null });
    await host.boot();
    const actorId = host.world.agents[0]!.id;
    const event = host.world.log.append({ type: 'born', worldTime: host.world.now(), simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: { species: 'sambar' }, outcome: 'success', effects: {}, causalParents: [],
      confidence: 'authoritative' });
    await host.snapshotNow();
    app = buildApi({ host, pool, social: { adminToken, xPublisher: publisher } });
    await app.ready();
    const draft = (await post('/admin/social/drafts', { eventId: event.id })).json();
    draftId = draft.id; body = draft.body; outbound = `${body} [VANA record ${draftId}]`;
  });
  afterAll(async () => { await app?.close(); await host?.abort(); await pool.end(); });

  it('stays disabled by default and requires explicit approval', async () => {
    expect(socialConfig({ VANA_SOCIAL_ADMIN_TOKEN: adminToken })).toEqual({ adminToken });
    expect(() => socialConfig({ VANA_SOCIAL_ADMIN_TOKEN: adminToken, VANA_X_PUBLISH_ENABLED: '1' })).toThrow();
    const disabled = buildApi({ host, pool, social: { adminToken } });
    try {
      await disabled.ready();
      expect((await disabled.inject({ method: 'POST', url: '/admin/social/x-publish', payload: { draftId }, headers })).statusCode).toBe(503);
    } finally { await disabled.close(); }
    expect((await post('/admin/social/x-publish', { draftId })).statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect((await post('/admin/social/review', { draftId, action: 'approve', note: 'Checked committed event' })).statusCode).toBe(200);
  });

  it('makes one durable create attempt and reconciles an uncertain response without resending', async () => {
    create.mockRejectedValueOnce(new Error('response lost after X accepted the request'));
    const first = await post('/admin/social/x-publish', { draftId });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ draftId, status: 'unknown', published: false });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(outbound);
    expect((await post('/admin/social/x-publish', { draftId })).json()).toEqual(first.json());
    expect(create).toHaveBeenCalledTimes(1);
    expect((await post('/admin/social/x-prepare', { draftId })).statusCode).toBe(409);
    expect((await post('/admin/social/review', { draftId, action: 'revoke', note: 'Change of mind' })).statusCode).toBe(409);
    expect((await pool.query('select action from x_publication_audit where draft_id=$1 order by id', [draftId])).rows
      .map((row) => row.action)).toEqual(['reserved', 'unknown']);

    await app.close(); app = buildApi({ host, pool, social: { adminToken, xPublisher: publisher } }); await app.ready();
    expect((await post('/admin/social/x-publish', { draftId })).json()).toEqual(first.json());
    expect(create).toHaveBeenCalledTimes(1);
    lookup.mockResolvedValueOnce({ id: '987', text: 'Different text', authorId: '456' });
    expect((await post('/admin/social/x-reconcile', { draftId, xPostId: '987' })).statusCode).toBe(409);
    lookup.mockResolvedValueOnce({ id: '987', text: outbound, authorId: '999' });
    expect((await post('/admin/social/x-reconcile', { draftId, xPostId: '987' })).statusCode).toBe(409);
    lookup.mockResolvedValueOnce({ id: '987', text: outbound, authorId: '456' });
    const resolved = await post('/admin/social/x-reconcile', { draftId, xPostId: '987' });
    expect(resolved.json()).toMatchObject({ status: 'published', published: true, xPostId: '987' });
    expect((await post('/admin/social/x-reconcile', { draftId, xPostId: '987' })).json()).toEqual(resolved.json());
    expect((await post('/admin/social/x-reconcile', { draftId, xPostId: '988' })).statusCode).toBe(409);
    expect((await app.inject({ url: `/admin/social/x-publications/${draftId}`, headers })).json()).toEqual(resolved.json());
    expect((await pool.query('select action from x_publication_audit where draft_id=$1 order by id', [draftId])).rows
      .map((row) => row.action)).toEqual(['reserved', 'unknown', 'reconciled']);
    expect((await app.inject({ url: `/admin/social/x-publications/${draftId}/audit`, headers })).json().entries
      .map((entry: { action: string }) => entry.action)).toEqual(['reserved', 'unknown', 'reconciled']);
  });

  it('checks the account before reserving, then confirms one successful create', async () => {
    const actorId = host.world.agents[0]!.id;
    const event = host.world.log.append({ type: 'died', worldTime: host.world.now(), simVersion: 'test', patchId: 0,
      actors: [actorId], conditions: { species: 'sambar' }, outcome: 'success', effects: {}, causalParents: [],
      confidence: 'authoritative' });
    await host.snapshotNow();
    const draft = (await post('/admin/social/drafts', { eventId: event.id })).json();
    const id = draft.id as string;
    await post('/admin/social/review', { draftId: id, action: 'approve', note: 'Checked saved death event' });
    verifyAccount.mockRejectedValueOnce(new Error('wrong X account'));
    expect((await post('/admin/social/x-publish', { draftId: id })).json()).toEqual({ error: 'x_account_verification_failed' });
    expect((await pool.query('select * from x_publications where draft_id=$1', [id])).rows).toEqual([]);
    create.mockImplementationOnce(async (text) => ({ id: '654', text }));
    const first = await post('/admin/social/x-publish', { draftId: id });
    expect(first.json()).toMatchObject({ status: 'published', published: true, xPostId: '654' });
    expect((await post('/admin/social/x-publish', { draftId: id })).json()).toEqual(first.json());
    expect(create).toHaveBeenCalledTimes(2); // One failed transport for the earlier draft, one success here.
    expect((await pool.query('select action from x_publication_audit where draft_id=$1 order by id', [id])).rows
      .map((row) => row.action)).toEqual(['reserved', 'confirmed']);
  });
});
