import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { landWalkable, patchCentre } from '@vana/shared';
import { createWorld, type World } from '@vana/sim';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { forgetPatchIndex, worldPort } from '../src/live/worldPort.js';
import { ChallengeStore } from '../src/challenges/store.js';
import { ChallengeEngine, GRACE_SECONDS, MAX_ATTEMPTS_PER_CHALLENGE, REFUND_MARGIN_SECONDS, WAIT_MS, type Player } from '../src/challenges/engine.js';
import { HERD_GRACE_MS } from '../src/challenges/rules.js';
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
  let port: ReturnType<typeof worldPort>;

  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate challenge_attempt_log, challenge_chain_ops, challenge_attempts, challenges, challenge_drafts, challenge_index_cursor, live_agents cascade');
    for (const id of ['ag_000000000000000a', 'ag_000000000000000b', 'ag_000000000000000c', 'ag_000000000000000d']) {
      await pool!.query(`insert into live_agents (id, public_key, name, name_key, network_hash) values ($1, $2, $1, $1, 'n')`,
        [id, id.replace('ag_', '').padEnd(43, 'A')]);
    }
    world = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents: { tiger: 2, chital: 12 }, minPopulation: {} });
    const open = world.patches.find((p) => landWalkable(p) && p.neighbours.every((n) => landWalkable(world.patches[n])))!;
    openPatch = open.id; centre = patchCentre(open.id);
    now = T0; worldNow = 1_000_000; random = 0; nextId = 0;
    const base = worldPort(() => world, () => 'w');
    // Tests move animals by hand; the port's half-second index must see each move at once.
    port = { ...base, now: () => worldNow, nearby: (x, z, radius, limit) => { forgetPatchIndex(); return base.nearby(x, z, radius, limit); } };
    live = new LiveLayer(port, null, () => now, () => random);
    store = new ChallengeStore(pool!);
    engine = new ChallengeEngine(store, live, port, () => now, { recordOnChain: true });
    live.onHunt = (h) => engine.onHunt(h);
    live.onCommand = (c) => engine.onCommand(c);
    live.onEnded = (l) => engine.onEnded(l);
    live.holdFreed = (speciesId, since) => engine.holdsFreed(speciesId, since);
    await engine.restore(); // also marks the engine ready to accept
  });

  const challenge = async (terms: ChallengeTerms, deadlineMs = T0 + 3 * 86_400_000) => {
    const id = ++nextId;
    await store.insertDraft({ creatorWallet: CREATOR, terms, rulesHash: rulesHash(terms), prizeAtomic: '10000000',
      deadline: new Date(deadlineMs), salt: hex('1'), authNonce: hex(String(id)) });
    await store.recordCreated(CONTRACT, { id, creator: CREATOR, prizeAtomic: '10000000', deadline: deadlineMs / 1000,
      rulesHash: rulesHash(terms), authNonce: hex(String(id)), txHash: hex(String(id)), blockNumber: id }, { challenge: '0x' + 'e'.repeat(40), ours: '0x' + 'e'.repeat(40) });
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
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
    expect(await engine.accept(player('ag_000000000000000a', { walletProven: false }), id)).toMatchObject({ ok: false, error: 'payout_wallet_required' });
    expect(await engine.accept(player('ag_000000000000000a', { wallet: CREATOR }), id)).toMatchObject({ ok: false, error: 'creator_cannot_play' });
    expect(await engine.accept(player('ag_000000000000000a'), 999)).toMatchObject({ ok: false, status: 404, error: 'not_found' });
    // A challenge opened straight on the contract (no draft of ours) cannot be played.
    await store.recordCreated(CONTRACT, { id: 50, creator: CREATOR, prizeAtomic: '10000000', deadline: (T0 + 86_400_000) / 1000,
      rulesHash: hex('9'), authNonce: hex('0'), txHash: hex('9'), blockNumber: 50 }, { challenge: '0x' + 'e'.repeat(40), ours: '0x' + 'e'.repeat(40) });
    expect(await engine.accept(player('ag_000000000000000a'), 50)).toMatchObject({ ok: false, error: 'not_open' });
    const late = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' }, T0 - 1);
    expect(await engine.accept(player('ag_000000000000000a'), late)).toMatchObject({ ok: false, error: 'deadline_passed' });
    live.possess('ag_000000000000000a', 'a', { speciesId: 'chital' });
    expect(await engine.accept(player('ag_000000000000000a'), id)).toMatchObject({ ok: false, error: 'release_your_animal_first' });
    expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: true, queued: false });
    // With two tigers on the island only one may be steered: the next player waits on the challenge's own list,
    // never in the species queue.
    expect(await engine.accept(player('ag_000000000000000c'), id)).toMatchObject({ ok: true, queued: true, position: 1 });
    expect(live.avatars.has('ag_000000000000000c')).toBe(false);
    expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: false, error: 'already_in_a_challenge' });
  });

  it('pays the first kill: the attempt is met with a verifiable record and the payout is queued', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
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
    const id = await challenge({ template: 'escape', version: 1, speciesId: 'chital', count: 1, rules: [], briefing: '' });
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
    const id = await challenge({ template: 'escape', version: 1, speciesId: 'chital', count: 3, rules: [], briefing: '' });
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

  it('refuses to start a survive attempt that could no longer finish before the deadline', async () => {
    const timed = new ChallengeEngine(store, live, port, () => now, { recordOnChain: true, worldHoursPerRealHour: 12 });
    await timed.restore();
    const terms: ChallengeTerms = { template: 'survive', version: 1, speciesId: 'chital', days: 7, rules: [], briefing: '' };
    // Seven forest days are 14 real hours at 12x.
    const soon = await challenge(terms, T0 + 10 * 3_600_000);
    expect(await timed.accept(player('ag_000000000000000a'), soon)).toMatchObject({ ok: false, status: 409, error: 'too_late_to_finish' });
    const later = await challenge(terms, T0 + 20 * 3_600_000);
    expect(await timed.accept(player('ag_000000000000000a'), later)).toMatchObject({ ok: true, queued: false });
  });

  it('hashes a win over its whole log, even while another write of the log is still under way', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    await engine.tick();
    // A command waits to be written; the records timer starts writing it, slowly.
    live.say('ag_000000000000000a', 'hello forest');
    const append = store.appendLog.bind(store);
    const slow = vi.spyOn(store, 'appendLog').mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return append(...args);
    });
    const records = engine.recordAttempts();
    worldNow += WORLD_DAY_SECONDS;
    await engine.tick();
    await records;
    slow.mockRestore();
    const met = (await store.attempt(a.attemptId))!;
    expect(met.status).toBe('met');
    const log = await store.log(a.attemptId);
    expect(log.map((e) => e.kind)).toContain('command');
    expect(JSON.parse(met.resultRecord!).log).toHaveLength(log.length);
  });

  it('starts a herd-rule attempt with an animal that is with its herd, not one alone across the island', async () => {
    const chital = world.agents.filter((a) => a.alive && a.speciesId === 'chital' && a.lifeStage === 'adult' && !a.controller);
    const far = world.patches.find((p) => landWalkable(p) && Math.hypot(patchCentre(p.id).x - centre.x, patchCentre(p.id).z - centre.z) > 3000)!;
    // The first candidate stands alone, far off; the rest graze together.
    chital[0]!.patchId = far.id; chital[0]!.position = { ...patchCentre(far.id), heading: 0 };
    chital.slice(1).forEach((a, i) => put(a.id, i * 5));
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [{ type: 'herd', maxDistanceM: 50 }], briefing: '' });
    const started = await accepted('ag_000000000000000a', id);
    expect(started.animalId).not.toBe(chital[0]!.id);
    expect(chital.slice(1).map((a) => a.id)).toContain(started.animalId);
  });

  it('meets a survive goal after the forest days pass, and fails at the deadline otherwise', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    worldNow += WORLD_DAY_SECONDS - 3600;
    await run(1);
    expect((await store.attempt(a.attemptId))!.status).toBe('running');
    worldNow += 3600;
    await run(1);
    expect((await store.attempt(a.attemptId))!.status).toBe('met');

    const other = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, rules: [], briefing: '' }, T0 + 60_000);
    const b = await engine.accept(player('ag_000000000000000b'), other);
    if (!b.ok) throw new Error(b.error);
    now = T0 + 60_000;
    await engine.tick();
    expect((await store.attempt(b.attemptId))!).toMatchObject({ status: 'failed', endReason: 'deadline' });
  });

  it('refunds an unwon challenge after deadline and grace, ending its attempts', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, rules: [], briefing: '' }, T0 + 60_000);
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
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 3, rules: [], briefing: '' });
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

  it('refuses to accept before it has started', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
    const cold = new ChallengeEngine(store, live, { ...worldPort(() => world, () => 'w'), now: () => worldNow }, () => now);
    expect(await cold.accept(player('ag_000000000000000a'), id)).toMatchObject({ ok: false, status: 503, error: 'challenges_starting' });
    expect(live.avatars.size).toBe(0);
  });

  it('cannot win a survive goal after the animal was let go while the attempt was being saved', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
    const save = store.startAttempt.bind(store);
    store.startAttempt = async (a) => { const saved = await save(a); live.release(a.agentId); return saved; };
    const result = await engine.accept(player('ag_000000000000000a'), id);
    expect(result).toMatchObject({ ok: false, error: 'animal_lost' });
    store.startAttempt = save;
    const [attempt] = await store.attemptsOf(id);
    expect(attempt).toMatchObject({ status: 'void', endReason: 'animal_lost' });
    worldNow += WORLD_DAY_SECONDS;
    await run(1);
    expect((await store.challenge(id))!.status).toBe('open');
  });

  it('fails an attempt whose animal is no longer the player\'s, even if no hook said so', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    live.avatars.delete('ag_000000000000000a'); // a missed onEnded
    worldNow += WORLD_DAY_SECONDS;
    await engine.tick();
    expect((await store.attempt(a.attemptId))!).toMatchObject({ status: 'failed', endReason: 'animal_lost' });
    expect((await store.challenge(id))!.status).toBe('open');
  });

  it('counts only kills made by the attempt\'s own animal', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    engine.onHunt({ predatorId: 'tiger_other', preyId: 'chital_x', predatorAgentId: 'ag_000000000000000a', preyAgentId: null, killed: true, at: now });
    await engine.tick();
    expect((await store.attempt(a.attemptId))!).toMatchObject({ status: 'running', kills: 0 });
  });

  it('keeps a win it failed to write, and records it on the next tick', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
    const a = await engine.accept(player('ag_000000000000000a'), id);
    if (!a.ok) throw new Error(a.error);
    const win = store.win.bind(store);
    let failures = 1;
    store.win = async (w) => { if (failures-- > 0) throw new Error('database unavailable'); return win(w); };
    worldNow += WORLD_DAY_SECONDS;
    await expect(engine.tick()).resolves.toBeUndefined();
    expect((await store.attempt(a.attemptId))!.status).toBe('running');
    await engine.tick();
    expect((await store.attempt(a.attemptId))!.status).toBe('met');
    expect((await store.challenge(id))!.status).toBe('won');
  });
  const avatarOf = (agentId: string) => live.avatars.get(agentId)!;
  const ended = async (attemptId: string) => (await store.attempt(attemptId))!;
  const accepted = async (agentId: string, id: number) => {
    const r = await engine.accept(player(agentId), id);
    if (!r.ok || r.queued) throw new Error(`not started: ${JSON.stringify(r)}`);
    return r;
  };

  it('ends an attempt for good, with its whole log, even when the database fails the first time', async () => {
    const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
    const started = await accepted('ag_000000000000000a', id);
    await engine.tick();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const append = vi.spyOn(store, 'appendLog').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const end = vi.spyOn(store, 'endAttempt').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    try {
      live.release('ag_000000000000000a');
      await engine.tick();
      expect(end).toHaveBeenCalled();
      expect((await pool!.query('select status from challenge_attempts where id = $1', [started.attemptId])).rows[0].status).toBe('running');
      await engine.tick();
      await engine.tick();
      expect((await pool!.query('select status, end_reason from challenge_attempts where id = $1', [started.attemptId])).rows[0])
        .toEqual({ status: 'failed', end_reason: 'released' });
      expect((await store.log(started.attemptId)).map((e) => e.kind)).toContain('end');
      expect(append).toHaveBeenCalled();
    } finally { errors.mockRestore(); append.mockRestore(); end.mockRestore(); }
  });

  it('fails an attempt that leaves its zone, and leaves the animal with the player', async () => {
    const at = wildChital().position;
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, briefing: '',
      rules: [{ type: 'zone', x: Math.round(at.x), z: Math.round(at.z), radiusM: 200 }] });
    const a = await accepted('ag_000000000000000a', id);
    const start = avatarOf('ag_000000000000000a');
    expect(Math.hypot(start.x - Math.round(at.x), start.z - Math.round(at.z))).toBeLessThanOrEqual(200);
    expect(engine.progressOf('ag_000000000000000a')).toMatchObject({ rules: [`stay within 200 m of (${Math.round(at.x)}, ${Math.round(at.z)})`] });
    await engine.tick();
    expect((await ended(a.attemptId)).status).toBe('running');
    start.x = Math.round(at.x) + 201; start.z = Math.round(at.z);
    await engine.tick();
    expect(await ended(a.attemptId)).toMatchObject({ status: 'failed', endReason: 'rule_zone' });
    expect(live.avatars.has('ag_000000000000000a')).toBe(true);
    expect(live.notices('ag_000000000000000a').map((n) => n.text).join(' ')).toMatch(/broke a rule/);
  });

  it('fails "never run" on a command to run, judged on the next tick', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, briefing: '', rules: [{ type: 'noRun' }] });
    const a = await accepted('ag_000000000000000a', id);
    const me = avatarOf('ag_000000000000000a');
    expect(live.moveTo('ag_000000000000000a', [{ x: me.x + 5, z: me.z }], 'trot')).toBeNull();
    await engine.tick();
    expect((await ended(a.attemptId)).status).toBe('running');
    expect(live.moveTo('ag_000000000000000a', [{ x: me.x - 5, z: me.z }], 'run')).toBeNull();
    live.stop('ag_000000000000000a'); // stopped at once: the command alone breaks the rule
    await engine.tick();
    expect(await ended(a.attemptId)).toMatchObject({ status: 'failed', endReason: 'rule_no_run' });
  });

  it("fails \"never run\" when a predator charges in a hunt", async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'tiger', days: 1, briefing: '', rules: [{ type: 'noRun' }] });
    const a = await accepted('ag_000000000000000a', id);
    const prey = wildChital();
    put(a.animalId, 0); put(prey.id, 20);
    expect(live.hunt('ag_000000000000000a', prey.id)).toBeNull();
    await run(5);
    expect(await ended(a.attemptId)).toMatchObject({ status: 'failed', endReason: 'rule_no_run' });
  });

  it('fails the herd rule after a minute apart from its own kind, and not before', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, briefing: '',
      rules: [{ type: 'herd', maxDistanceM: 50 }] });
    const a = await accepted('ag_000000000000000a', id);
    put(a.animalId, 0);
    const kin = world.agents.filter((x) => x.alive && x.speciesId === 'chital' && x.id !== a.animalId);
    const away = () => { for (const k of kin) k.position = { x: centre.x + 5000, z: centre.z, heading: 0 }; };
    const near = () => { kin[0]!.patchId = openPatch; kin[0]!.position = { x: centre.x + 30, z: centre.z, heading: 0 }; };
    near();
    await run(70);
    expect((await ended(a.attemptId)).status).toBe('running');
    away();
    await run(59);
    expect((await ended(a.attemptId)).status).toBe('running');
    near();
    await run(5);
    away();
    await run(Math.ceil(HERD_GRACE_MS / 1000) - 2);
    expect((await ended(a.attemptId)).status).toBe('running');
    await run(4);
    expect(await ended(a.attemptId)).toMatchObject({ status: 'failed', endReason: 'rule_herd' });
  });

  it('starts a reach attempt at least a kilometre from its target, and wins it within 25 m', async () => {
    // A spot on land 1.2-2 km from a chital, with a chital right beside it that must not be chosen.
    const herd = wildChital();
    const spot = world.patches.map((p) => patchCentre(p.id)).find((c, i) => landWalkable(world.patches[i]!)
      && Math.hypot(c.x - herd.position!.x, c.z - herd.position!.z) > 1200 && Math.hypot(c.x - herd.position!.x, c.z - herd.position!.z) < 2000)!;
    const tx = Math.round(spot.x), tz = Math.round(spot.z);
    const near = world.agents.find((x) => x.alive && x.speciesId === 'chital' && x.id !== herd.id && !x.controller)!;
    near.position = { x: tx + 10, z: tz, heading: 0 };
    const id = await challenge({ template: 'reach', version: 1, speciesId: 'chital', x: tx, z: tz, rules: [], briefing: '' });
    const a = await accepted('ag_000000000000000a', id);
    const me = avatarOf('ag_000000000000000a');
    expect(Math.hypot(me.x - tx, me.z - tz)).toBeGreaterThanOrEqual(1000);
    expect(engine.progressOf('ag_000000000000000a')!.progress.unit).toBe('metres to go');
    me.x = tx + 26; me.z = tz;
    await engine.tick();
    expect((await ended(a.attemptId)).status).toBe('running');
    me.x = tx + 24;
    await engine.tick();
    expect((await ended(a.attemptId)).status).toBe('met');
    expect((await store.challenge(id))!.status).toBe('won');
  });

  it('allows three attempts per agent at a challenge', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, rules: [], briefing: '' });
    for (let i = 0; i < MAX_ATTEMPTS_PER_CHALLENGE; i++) {
      await accepted('ag_000000000000000a', id);
      live.release('ag_000000000000000a');
      await engine.tick();
    }
    expect(await engine.accept(player('ag_000000000000000a'), id)).toMatchObject({ ok: false, status: 409, error: 'no_attempts_left' });
    expect((await engine.accept(player('ag_000000000000000b'), id)).ok).toBe(true);
  });

  describe('waiting list', () => {
    it('serves agents in order and never lets a newcomer jump the list', async () => {
      const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      const other = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      await accepted('ag_000000000000000a', id);
      expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: true, queued: true, position: 1 });
      expect(await engine.accept(player('ag_000000000000000c'), id)).toMatchObject({ ok: true, queued: true, position: 2 });
      expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: true, queued: true, position: 1 });
      expect(await engine.accept(player('ag_000000000000000b'), other)).toMatchObject({ ok: false, error: 'already_waiting' });
      expect(engine.waitingOf('ag_000000000000000c')).toMatchObject({ challengeId: id, position: 2 });
      // The tiger comes free; a newcomer accepting before the next tick still goes to the back.
      live.release('ag_000000000000000a');
      expect(await engine.accept(player('ag_000000000000000d'), id)).toMatchObject({ ok: true, queued: true, position: 3 });
      await engine.tick();
      expect(engine.progressOf('ag_000000000000000b')).toMatchObject({ challengeId: id });
      expect(engine.waitingOf('ag_000000000000000b')).toBeNull();
      expect(engine.waitingOf('ag_000000000000000c')).toMatchObject({ position: 1 });
      expect(engine.waitingOf('ag_000000000000000d')).toMatchObject({ position: 2 });
      expect(live.notices('ag_000000000000000b').map((n) => n.text).join(' ')).toMatch(/came free/);
    });

    it('shares a freed animal fairly with the species queue: whoever waited longer gets it', async () => {
      const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      await accepted('ag_000000000000000a', id);
      expect(await engine.accept(player('ag_000000000000000b'), id)).toMatchObject({ ok: true, queued: true, position: 1 });
      now += 1000;
      expect(live.possess('ag_000000000000000c', 'c', { speciesId: 'tiger' })).toEqual({ ok: false, reason: 'queued:1' });
      // The challenge's player waited longer: the species queue leaves the tiger for it.
      live.release('ag_000000000000000a');
      expect(live.avatars.has('ag_000000000000000c')).toBe(false);
      await engine.tick();
      expect(engine.progressOf('ag_000000000000000b')).toMatchObject({ challengeId: id });
      // Now the species queue's agent waited longer than the challenge's next player, so it goes first.
      now += 1000;
      expect(await engine.accept(player('ag_000000000000000d'), id)).toMatchObject({ ok: true, queued: true, position: 1 });
      live.release('ag_000000000000000b');
      expect(live.avatars.get('ag_000000000000000c')?.speciesId).toBe('tiger');
    });

    it('keeps an agent who joined while the list was being served', async () => {
      const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      await accepted('ag_000000000000000a', id);
      await engine.accept(player('ag_000000000000000b'), id);
      // Someone accepts while the tick is reading the challenge for the waiting list.
      const read = store.challenge.bind(store);
      let once = true;
      vi.spyOn(store, 'challenge').mockImplementation(async (n) => {
        if (once) { once = false; await engine.accept(player('ag_000000000000000c'), id); }
        return read(n);
      });
      await engine.tick();
      expect(engine.waitingOf('ag_000000000000000b')).toMatchObject({ position: 1 });
      expect(engine.waitingOf('ag_000000000000000c')).toMatchObject({ position: 2 });
    });

    it('drops waits that run out, close, or are left, and agents who took another animal', async () => {
      const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      await accepted('ag_000000000000000a', id);
      await engine.accept(player('ag_000000000000000b'), id);
      await engine.accept(player('ag_000000000000000c'), id);
      await engine.accept(player('ag_000000000000000d'), id);
      expect(engine.leave('ag_000000000000000d')).toBe(true);
      expect(engine.leave('ag_000000000000000d')).toBe(false);
      live.possess('ag_000000000000000c', 'c', { speciesId: 'chital' });
      await engine.tick();
      expect(engine.waitingOf('ag_000000000000000c')).toBeNull();
      now += WAIT_MS - 1;
      await engine.tick();
      expect(engine.waitingOf('ag_000000000000000b')).toMatchObject({ position: 1 });
      now += 1;
      await engine.tick();
      expect(engine.waitingOf('ag_000000000000000b')).toBeNull();
      expect(live.notices('ag_000000000000000b').map((n) => n.text).join(' ')).toMatch(/off its waiting list/);

      const closing = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' }, now + 86_400_000);
      await engine.accept(player('ag_000000000000000b'), closing);
      await store.setStatus(closing, ['open'], 'refunding');
      await engine.tick();
      expect(engine.waitingOf('ag_000000000000000b')).toBeNull();
    });
  });

  it('gives every ended attempt a hashed record, and queues its start and end for the chain', async () => {
    const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, rules: [], briefing: '' });
    const a = await accepted('ag_000000000000000a', id);
    await engine.recordAttempts();
    expect((await store.opsOf({ attemptId: a.attemptId })).map((o) => [o.kind, o.payload])).toEqual([['record_start', { player: PAYOUT }]]);
    live.release('ag_000000000000000a');
    await engine.tick();
    await engine.recordAttempts();
    const done = await ended(a.attemptId);
    expect(done.resultHash).toBe(keccak256(toBytes(done.resultRecord!)));
    expect(JSON.parse(done.resultRecord!)).toMatchObject({ kind: 'wildsentia-challenge-result', challengeId: id, attemptId: a.attemptId,
      outcome: 'failed', reason: 'released', log: [{ kind: 'start' }, { kind: 'command', data: { command: 'release' } }, { kind: 'end' }] });
    expect((await store.opsOf({ attemptId: a.attemptId })).map((o) => [o.kind, o.payload])).toEqual([
      ['record_start', { player: PAYOUT }], ['record_end', { outcome: 2, logHash: done.resultHash }]]);
    await engine.recordAttempts();
    expect(await store.opsOf({ attemptId: a.attemptId })).toHaveLength(2);

    // Without the attempts contract the record is still kept, and nothing is queued for the chain.
    const offChain = new ChallengeEngine(store, live, port, () => now);
    const b = await accepted('ag_000000000000000b', id);
    live.release('ag_000000000000000b');
    await engine.tick();
    await pool!.query('delete from challenge_chain_ops where attempt_id = $1', [b.attemptId]);
    await offChain.recordAttempts();
    expect((await ended(b.attemptId)).resultHash).not.toBeNull();
    expect(await store.opsOf({ attemptId: b.attemptId })).toEqual([]);
  });
  describe('review fixes', () => {
    it('judges a zone start on where the animal will actually be placed, not where it is shown', async () => {
      const a = wildChital();
      const at = { x: Math.round(a.position!.x), z: Math.round(a.position!.z) };
      // Every chital is being shown far from its saved position (the hour's route as played).
      port.playedPosition = (id) => { const x = world.animal(id)!; return { x: x.position.x + 5000, z: x.position.z, heading: 0 }; };
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, briefing: '',
        rules: [{ type: 'zone', ...at, radiusM: 200 }] });
      const r = await accepted('ag_000000000000000a', id);
      const me = avatarOf('ag_000000000000000a');
      expect(Math.hypot(me.x - at.x, me.z - at.z)).toBeLessThanOrEqual(200);
      await engine.tick();
      expect((await ended(r.attemptId)).status).toBe('running');
    });

    it('finds a free animal in a zone however far down the island\'s list it is', async () => {
      world = createWorld({ seed: 6, speciesDir, terrainProfile: 'island_v1', initialAgents: { tiger: 2, chital: 260 }, minPopulation: {} });
      const last = world.agents.filter((x) => x.speciesId === 'chital' && x.alive && !x.dependentOn).at(-1)!;
      const lone = world.patches.find((p) => landWalkable(p) && world.agents.every((x) => x === last || !x.position
        || Math.hypot(x.position.x - patchCentre(p.id).x, x.position.z - patchCentre(p.id).z) > 600))!;
      const c = patchCentre(lone.id);
      last.patchId = lone.id; last.position = { x: c.x, z: c.z, heading: 0 };
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, briefing: '',
        rules: [{ type: 'zone', x: Math.round(c.x), z: Math.round(c.z), radiusM: 200 }] });
      const r = await accepted('ag_000000000000000a', id);
      expect(r.animalId).toBe(last.id);
    });

    it('finds kin for the herd rule where they are shown, even far from their saved spots', async () => {
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 7, briefing: '',
        rules: [{ type: 'herd', maxDistanceM: 30 }] });
      const a = await accepted('ag_000000000000000a', id);
      put(a.animalId, 0);
      const kin = world.agents.filter((x) => x.alive && x.speciesId === 'chital' && x.id !== a.animalId);
      for (const k of kin) { k.patchId = openPatch; k.position = { x: centre.x + 400, z: centre.z, heading: 0 }; }
      // Saved 400 m away, but shown 10 m from the player's animal right now.
      port.playedPosition = (pid) => (kin.some((k) => k.id === pid) ? { x: avatarOf('ag_000000000000000a').x + 10, z: centre.z, heading: 0 } : null);
      await run(90);
      expect((await ended(a.attemptId)).status).toBe('running');
    });

    it('catches a predator\'s charge that ends before the next check', async () => {
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'tiger', days: 1, briefing: '', rules: [{ type: 'noRun' }] });
      const a = await accepted('ag_000000000000000a', id);
      const prey = wildChital();
      put(a.animalId, 0); put(prey.id, 20);
      expect(live.hunt('ag_000000000000000a', prey.id)).toBeNull();
      for (let i = 0; i < 4; i++) { now += 100; live.tick(0.1); } // a short charge, no engine tick
      live.stop('ag_000000000000000a');
      await engine.tick();
      expect(await ended(a.attemptId)).toMatchObject({ status: 'failed', endReason: 'rule_no_run' });
    });

    it('keeps the creator\'s briefing out of the goal it shows, and labels it', async () => {
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: 'Go to the river.' });
      await accepted('ag_000000000000000a', id);
      const p = engine.progressOf('ag_000000000000000a')!;
      expect(p.goal).not.toHaveProperty('briefing');
      expect(p.briefing).toBe('Go to the river.');
    });

    it('tells a waiter why it was dropped, and keeps it on the list through a cooldown', async () => {
      const id = await challenge({ template: 'hunt', version: 1, speciesId: 'tiger', count: 1, rules: [], briefing: '' });
      await accepted('ag_000000000000000a', id);
      await engine.accept(player('ag_000000000000000b'), id);
      await engine.accept(player('ag_000000000000000c'), id);
      live.possess('ag_000000000000000c', 'c', { speciesId: 'chital' });
      live.release('ag_000000000000000a');
      const possess = vi.spyOn(live, 'possess').mockReturnValueOnce({ ok: false, reason: 'cooldown' });
      await engine.tick();
      expect(live.notices('ag_000000000000000c').map((n) => n.text).join(' ')).toMatch(/off the waiting list/);
      expect(engine.waitingOf('ag_000000000000000b')).toMatchObject({ position: 1 });
      possess.mockRestore();
      await engine.tick();
      expect(engine.progressOf('ag_000000000000000b')).toMatchObject({ challengeId: id });
    });

    it('hashes a winning record that matches its public log exactly', async () => {
      const id = await challenge({ template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' });
      const a = await accepted('ag_000000000000000a', id);
      // A command arrives while the win is being written.
      const read = store.log.bind(store);
      let once = true;
      vi.spyOn(store, 'log').mockImplementation(async (attemptId) => {
        const rows = await read(attemptId);
        if (once) { once = false; live.stop('ag_000000000000000a'); }
        return rows;
      });
      worldNow += WORLD_DAY_SECONDS;
      await engine.tick();
      await engine.tick();
      vi.restoreAllMocks();
      const done = await ended(a.attemptId);
      expect(done.status).toBe('met');
      expect(JSON.parse(done.resultRecord!).log).toHaveLength((await store.log(a.attemptId)).length);
    });
  });

  it('never lets a creator play their own challenge, even from a wallet linked since', async () => {
    // A person's identity created the draft through their account; they then link another wallet.
    await pool!.query(`insert into accounts (id, x_user_id, x_handle, x_name, x_created_at, agent_id)
      values ('11111111-1111-1111-1111-111111111111', '5', 'a', 'A', now() - interval '400 days', 'ag_000000000000000a')`);
    const terms = { template: 'survive', version: 1, speciesId: 'chital', days: 1, rules: [], briefing: '' } as const;
    const id = await challenge(terms);
    await pool!.query("update challenge_drafts set account_id = '11111111-1111-1111-1111-111111111111'");
    expect(await engine.accept(player('ag_000000000000000a', { wallet: '0x' + 'f'.repeat(40) }), id))
      .toMatchObject({ ok: false, error: 'creator_cannot_play' });
    expect((await engine.accept(player('ag_000000000000000b'), id)).ok).toBe(true);
  });
});
