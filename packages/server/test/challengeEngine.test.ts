import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { ChallengeEngine, GRACE_SECONDS, REFUND_MARGIN_SECONDS, type Player } from '../src/challenges/engine.js';
import { WORLD_DAY_SECONDS } from '../src/challenges/goals.js';
import { rulesHash, type ChallengeTerms } from '../src/challenges/terms.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
const CONTRACT = '0x' + 'c'.repeat(40), CREATOR = '0x' + 'a'.repeat(40), PAYOUT = '0x' + 'b'.repeat(40);
const hex = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const T0 = Date.parse('2026-10-10T00:00:00Z');

maybe('challenge engine', () => {
  let world: World, live: LiveLayer, store: ChallengeStore, engine: ChallengeEngine;
  let now: number, worldNow: number, random: number, nextId: number;
  let centre: { x: number; z: number };
  let openPatch: number;

  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    for (const id of ['ag_000000000000000a', 'ag_000000000000000b', 'ag_000000000000000c']) {
      await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ($1, $2, $1, $1, 'n')`,
        [id, id.replace('ag_', '').padEnd(43, 'A')]);
    }
    world = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
    const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
    openPatch = open.id; centre = patchCentre(open.id);
    now = T0; worldNow = 1_000_000; random = 0; nextId = 0;
    const port = { ...worldPort(() => world, () => 'w'), now: () => worldNow };
    live = new LiveLayer(port, null, () => now, () => random);
    store = new ChallengeStore(pool!);
    engine = new ChallengeEngine(store, live, port, () => now);
    live.onHunt = (h) => engine.onHunt(h);
    live.onCommand = (c) => engine.onCommand(c);
    live.onEnded = (l) => engine.onEnded(l);
  });

  const challenge = async (terms: ChallengeTerms, deadlineMs = T0 + 3 * 86_400_000) => {
    const id = ++nextId;
    await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '10000000',
      deadline: new Date(deadlineMs), salt: hex('1'), authNonce: hex(String(id)) });
    await store.recordCreated(CONTRACT, { id, creator: CREATOR, prizeAtomic: '10000000', deadline: deadlineMs / 1000,
      rulesHash: rulesHash(terms), authNonce: hex(String(id)), txHash: hex(String(id)), blockNumber: id });
    return id;
  };
  const player = (agentId: string, over: Partial<Player> = {}): Player => ({ agentId, name: agentId, wallet: PAYOUT, walletProven: true, ...over });
  const put = (id: string, dx: number) => {
    const a = world.animal(id)!;
    a.patchId = openPatch; a.position = { x: centre.x + dx, z: centre.z, heading: 0 };
    const avatar = [...live.avatars.values()].find((v) => v.animalId === id);
    if (avatar) { avatar.x = centre.x + dx; avatar.z = centre.z; }
  };
  const run = async (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) { now += 100; live.tick(0.1); if (i % 10 === 9) await engine.tick(); }
  };
  const wildChital = () => world.agents.find((a) => a.alive && a.speciesId === 'chital' && !a.controller && a.lifeStage === 'adult')!;

  it('refuses players who cannot take part', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger' });
    expect(await engine.accept(player('ag_000000000000000a', { walletProven: false }), id)).toMatchObject({ ok: false, error: 'payout_wallet_required' });
    expect(await engine.accept(player('ag_000000000000000a', { wallet: CREATOR }), id)).toMatchObject({ ok: false, error: 'creator_cannot_play' });
    expect(await engine.accept(player('ag_000000000000000a'), 999)).toMatchObject({ ok: false, status: 404, error: 'not_found' });
    // A challenge opened straight on the contract (no draft of ours) cannot be played.
    await store.recordCreated(CONTRACT, { id: 50, creator: CREATOR, prizeAtomic: '10000000', deadline: (T0 + 86_400_000) / 1000,
      rulesHash: hex('9'), authNonce: hex('0'), txHash: hex('9'), blockNumber: 50 });
    expect(await engine.accept(player('ag_000000000000000a'), 50)).toMatchObject({ ok: false, error: 'not_open' });
    const late = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger' }, T0 - 1);
    expect(await engine.accept(player('ag_000000000000000a'), late)).toMatchObject({ ok: false, error: 'deadline_passed' });
    live.possess('ag_000000000000000a', 'a', { speciesId: 'chital' });
    expect(await engine.accept(player('ag_000000000000000a'), id)).toMatchObject({ ok: false, error: 'release_your_animal_first' });
    expect((await engine.accept(player('ag_000000000000000b'), id)).ok).toBe(true);
    // With two tigers on the island only one may be steered: no free animal, and no silent place in the species queue.
    expect(await engine.accept(player('ag_000000000000000c'), id)).toMatchObject({ ok: false, error: 'no_free_animal' });
    expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: false, error: 'already_in_a_challenge' });
  });

  it('pays the first kill: the attempt is met with a verifiable record and the payout is queued', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger' });
    const accepted = await engine.accept(player('ag_000000000000000a'), id);
    if (!accepted.ok) throw new Error(accepted.error);
    expect(engine.progressOf('ag_000000000000000a')).toMatchObject({ challengeId: id, progress: { done: 0, of: 1, unit: 'kills' } });
    const prey = wildChital();
    put(accepted.animalId, 0); put(prey.id, 30);
    expect(live.hunt('ag_000000000000000a', prey.id)).toBeNull();
    await run(60);
    const attempt = (await store.attempt(accepted.attemptId))!;
    expect(attempt).toMatchObject({ status: 'met', endReason: 'goal_met', kills: 1 });
    expect(attempt.resultHash).toBe(keccak256(toBytes(attempt.resultRecord!)));
    const record = JSON.parse(attempt.resultRecord!);
    expect(record).toMatchObject({ challengeId: id, attemptId: attempt.id, payoutWallet: PAYOUT, terms: { template: 'hunt' } });
    expect(record.log.map((e: { kind: string }) => e.kind)).toEqual(['start', 'command', 'hunt', 'end']);
    expect((await store.challenge(id))!).toMatchObject({ status: 'won', winnerAttempt: attempt.id });
    expect((await store.opsOf({ challengeId: id }))[0]).toMatchObject({ kind: 'resolve', payload: { winner: PAYOUT, resultHash: attempt.resultHash } });
    expect(engine.progressOf('ag_000000000000000a')).toBeNull();
    expect(live.avatars.has('ag_000000000000000a')).toBe(true); // the tiger stays the player's
  });

  it('counts an escape for prey a hunter failed to catch', async () => {
    random = 0.999; // every catch fails
    const id = await challenge({ template: 'escape', version: 1, speciesId: 'chital', count: 1 });
    const accepted = await engine.accept(player('ag_000000000000000a'), id);
    if (!accepted.ok) throw new Error(accepted.error);
    const tiger = world.agents.find((a) => a.alive && a.speciesId === 'tiger' && !a.controller)!;
    live.possess('ag_000000000000000b', 'b', { animalId: tiger.id });
    put(tiger.id, 0); put(accepted.animalId, 30);
    live.hunt('ag_000000000000000b', accepted.animalId);
    await run(60);
    expect((await store.attempt(accepted.attemptId))!).toMatchObject({ status: 'met', escapes: 1 });
  });

  it('fails an attempt whose animal is caught, and voids one that gives birth', async () => {
    const id = await challenge({ template: 'escape', version: 1, speciesId: 'chital', count: 3 });
    const accepted = await engine.accept(player('ag_000000000000000a'), id);
    if (!accepted.ok) throw new Error(accepted.error);
    const tiger = world.agents.find((a) => a.alive && a.speciesId === 'tiger' && !a.controller)!;
    live.possess('ag_000000000000000b', 'b', { animalId: tiger.id });
    put(tiger.id, 0); put(accepted.animalId, 30);
    live.hunt('ag_000000000000000b', accepted.animalId);
    await run(60);
    await engine.tick();
    expect((await store.attempt(accepted.attemptId))!).toMatchObject({ status: 'failed', endReason: 'caught' });

    const second = await engine.accept(player('ag_000000000000000c'), id);
    if (!second.ok) throw new Error(second.error);
    world.animal(second.animalId)!.controller = undefined; // what giving birth does to a possessed mother
    await run(1);
    await engine.tick();
    expect((await store.attempt(second.attemptId))!).toMatchObject({ status: 'void', endReason: 'birth' });
  });

  it('meets a survive goal after the forest days pass, and fails at the deadline otherwise', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1 });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    worldNow += WORLD_DAY_SECONDS - 3600;
    await run(1);
    expect((await store.attempt(a.attemptId))!.status).toBe('running');
    worldNow += 3600;
    await run(1);
    expect((await store.attempt(a.attemptId))!.status).toBe('met');

    const other = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7 }, T0 + 60_000);
    const b = await engine.accept(player('ag_000000000000000b'), other);
    if (!b.ok) throw new Error(b.error);
    now = T0 + 60_000;
    await engine.tick();
    expect((await store.attempt(b.attemptId))!).toMatchObject({ status: 'failed', endReason: 'deadline' });
  });

  it('refunds an unwon challenge after deadline and grace, ending its attempts', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7 }, T0 + 60_000);
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    now = T0 + 60_000 + (GRACE_SECONDS + REFUND_MARGIN_SECONDS) * 1000;
    await engine.sweep();
    expect((await store.challenge(id))!.status).toBe('open');
    now += 1;
    await engine.sweep();
    expect((await store.challenge(id))!.status).toBe('refunding');
    expect((await store.opsOf({ challengeId: id }))[0]).toMatchObject({ kind: 'refund', status: 'pending' });
    expect((await store.attempt(a.attemptId))!).toMatchObject({ status: 'failed', endReason: 'deadline' });
    await engine.sweep();
    expect(await store.opsOf({ challengeId: id })).toHaveLength(1);
  });

  it('picks running attempts up after a restart, and voids one whose animal was lost', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 3 });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    const b = await engine.accept(player('ag_000000000000000b'), id);
    if (!a.ok || !b.ok) throw new Error('accept failed');
    await engine.tick();
    live.avatars.delete('ag_000000000000000b'); // its possession did not survive the restart
    const restarted = new ChallengeEngine(store, live, { ...worldPort(() => world, () => 'w'), now: () => worldNow }, () => now);
    await restarted.restore();
    expect(restarted.progressOf('ag_000000000000000a')).toMatchObject({ attemptId: a.attemptId });
    expect((await store.attempt(b.attemptId))!).toMatchObject({ status: 'void', endReason: 'lost_in_restart' });
  });
});
