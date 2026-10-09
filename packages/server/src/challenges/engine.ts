import { keccak256, toBytes } from 'viem';
import type { CommandRecord, EndedLife, HuntOutcome, LiveLayer, WorldPort } from '../live/liveLayer.js';
import { goalMet, progressOf } from './goals.js';
import type { Attempt, Challenge, ChallengeStore, Hex, LogEntry } from './store.js';
import type { ChallengeTerms } from './terms.js';

/**
 * Runs challenge attempts on the live layer (docs/2026-10-09-challenges-design.md §4): starts a
 * possession for an accepted challenge, counts kills and escapes from live hunts, checks goals,
 * ends attempts when the animal is lost or the deadline passes, and hands the first attempt to
 * meet its goal to the store, which queues the payout. Refunds of unwon prizes are queued here too.
 */

/** Seconds after the deadline in which the contract still pays (WildsentiaChallenges.GRACE). */
export const GRACE_SECONDS = 3600;
/** Extra wait before queuing a refund, so the server's clock never runs ahead of the chain's. */
export const REFUND_MARGIN_SECONDS = 120;
/** An attempt's log keeps at most this many entries; past it, only hunts and the end are kept. */
export const MAX_LOG_ENTRIES = 5000;

export interface Player { agentId: string; name: string; wallet: string | null; walletProven: boolean }
export type AcceptResult =
  | { ok: true; attemptId: string; animalId: string }
  | { ok: false; status: number; error: string };

interface Running {
  attempt: Attempt; terms: ChallengeTerms; deadline: number; kills: number; escapes: number; logged: number; finishing: boolean;
  /** The goal-met entry is logged once, even if recording the win has to be retried. */
  endLogged?: boolean;
}

export class ChallengeEngine {
  readonly #running = new Map<string, Running>();
  #pending: Array<{ attemptId: string; entry: LogEntry }> = [];
  /** Attempts ended by a live-layer hook, still being written; the next tick waits for them. */
  #ending: Array<Promise<void>> = [];
  /** False until restore() has run (and the hooks are wired): no attempt starts before then. */
  #ready = false;

  constructor(private readonly store: ChallengeStore, private readonly live: LiveLayer, private readonly world: WorldPort,
    private readonly clock: () => number = Date.now) {}

  /** Picks up attempts still running before a restart; one whose animal was lost is void. */
  async restore(): Promise<void> {
    for (const attempt of await this.store.runningAttempts()) {
      const avatar = this.live.avatars.get(attempt.agentId);
      const challenge = await this.store.challenge(attempt.challengeId);
      if (!avatar || avatar.animalId !== attempt.animalId || !challenge?.terms) {
        await this.store.endAttempt(attempt.id, 'void', 'lost_in_restart', this.world.now());
        continue;
      }
      const logged = (await this.store.log(attempt.id)).length;
      this.#running.set(attempt.agentId, { attempt, terms: challenge.terms, deadline: challenge.deadline.getTime(),
        kills: attempt.kills, escapes: attempt.escapes, logged, finishing: false });
    }
    this.#ready = true;
  }

  async accept(player: Player, challengeId: number): Promise<AcceptResult> {
    if (!this.#ready) return { ok: false, status: 503, error: 'challenges_starting' };
    const c = await this.store.challenge(challengeId);
    if (!c) return { ok: false, status: 404, error: 'not_found' };
    if (c.status !== 'open' || !c.terms) return { ok: false, status: 409, error: 'not_open' };
    if (this.clock() >= c.deadline.getTime()) return { ok: false, status: 409, error: 'deadline_passed' };
    if (!player.wallet || !player.walletProven) return { ok: false, status: 403, error: 'payout_wallet_required' };
    if (player.wallet.toLowerCase() === c.creatorWallet) return { ok: false, status: 403, error: 'creator_cannot_play' };
    if (this.#running.has(player.agentId)) return { ok: false, status: 409, error: 'already_in_a_challenge' };
    if (this.live.avatars.has(player.agentId)) return { ok: false, status: 409, error: 'release_your_animal_first' };
    // A named free animal, never the species queue: a queued agent would get it later outside the challenge.
    const free = this.world.candidates(c.terms.speciesId, 20).find((a) => !this.live.wild.has(a.id));
    if (!free) return { ok: false, status: 409, error: 'no_free_animal' };
    const taken = this.live.possess(player.agentId, player.name, { animalId: free.id });
    if (!taken.ok) return { ok: false, status: 409, error: taken.reason };
    const animal = this.world.animal(free.id)!;
    const startState = { animalId: animal.id, speciesId: animal.speciesId, lifeStage: animal.lifeStage,
      position: { x: taken.avatar.x, z: taken.avatar.z }, drives: animal.drives };
    let attempt: Attempt;
    try {
      attempt = await this.store.startAttempt({ challengeId, agentId: player.agentId, animalId: animal.id,
        payoutWallet: player.wallet, startedWorld: this.world.now(), startState });
    } catch (error) {
      this.live.release(player.agentId, 'The challenge could not start, so your animal went back to the wild.', 'idle');
      throw error;
    }
    // The animal may have been let go while the attempt was being saved (a release in between
    // reached onEnded before this run existed): then the attempt never really started.
    if (!this.#holds(player.agentId, animal.id)) {
      await this.store.endAttempt(attempt.id, 'void', 'animal_lost', this.world.now());
      return { ok: false, status: 409, error: 'animal_lost' };
    }
    const run: Running = { attempt, terms: c.terms, deadline: c.deadline.getTime(), kills: 0, escapes: 0, logged: 0, finishing: false };
    this.#running.set(player.agentId, run);
    this.#log(run, 'start', { challengeId, ...startState, worldTime: attempt.startedWorld });
    this.live.notify(player.agentId, `Challenge ${challengeId} started.`);
    return { ok: true, attemptId: attempt.id, animalId: animal.id };
  }

  /** The player's current attempt, for observe. */
  progressOf(agentId: string): { challengeId: number; attemptId: string; goal: ChallengeTerms; progress: { done: number; of: number; unit: string };
    deadline: string } | null {
    const run = this.#running.get(agentId);
    if (!run) return null;
    return { challengeId: run.attempt.challengeId, attemptId: run.attempt.id, goal: run.terms,
      progress: progressOf(run.terms, { startedWorld: run.attempt.startedWorld, kills: run.kills, escapes: run.escapes }, this.world.now()),
      deadline: new Date(run.deadline).toISOString() };
  }

  // ---- live layer hooks (synchronous; database work follows on the next tick) ----------

  onCommand(record: CommandRecord): void {
    const run = this.#running.get(record.agentId);
    if (run) this.#log(run, 'command', { command: record.command, ...record.args });
  }

  onHunt(hunt: HuntOutcome): void {
    // Only the attempt's own animal counts, whoever steers it now.
    const hunter = hunt.predatorAgentId ? this.#running.get(hunt.predatorAgentId) : undefined;
    if (hunter && hunter.attempt.animalId === hunt.predatorId) {
      if (hunt.killed) hunter.kills++;
      this.#log(hunter, 'hunt', { as: 'predator', predatorId: hunt.predatorId, preyId: hunt.preyId, killed: hunt.killed });
    }
    const prey = hunt.preyAgentId ? this.#running.get(hunt.preyAgentId) : undefined;
    if (prey && prey.attempt.animalId === hunt.preyId) {
      if (!hunt.killed) prey.escapes++;
      this.#log(prey, 'hunt', { as: 'prey', predatorId: hunt.predatorId, preyId: hunt.preyId, killed: hunt.killed });
    }
  }

  onEnded(life: EndedLife): void {
    const run = this.#running.get(life.agentId);
    if (!run || run.finishing || run.attempt.animalId !== life.animalId) return;
    run.finishing = true;
    this.#running.delete(life.agentId);
    this.#log(run, 'end', { how: life.how });
    // Giving birth hands the animal back to the wild: not the player's failure, so the attempt is void.
    this.#ending.push(this.#finish(run, life.how === 'birth' ? 'void' : 'failed', life.how));
  }

  // ---- timers -------------------------------------------------------------------------------

  /** Once a second: write logs and progress, check goals and deadlines. */
  async tick(): Promise<void> {
    const ending = this.#ending;
    this.#ending = [];
    await Promise.all(ending);
    await this.#flush();
    const worldNow = this.world.now();
    for (const [agentId, run] of [...this.#running]) {
      if (run.finishing) continue;
      // Never judge a goal for an animal the player no longer holds, whatever the hooks said.
      if (!this.#holds(agentId, run.attempt.animalId)) {
        run.finishing = true;
        this.#running.delete(agentId);
        this.#log(run, 'end', { how: 'animal_lost' });
        await this.#finish(run, 'failed', 'animal_lost');
        continue;
      }
      if (run.kills !== run.attempt.kills || run.escapes !== run.attempt.escapes) {
        await this.store.saveProgress(run.attempt.id, run.kills, run.escapes);
        run.attempt = { ...run.attempt, kills: run.kills, escapes: run.escapes };
      }
      if (goalMet(run.terms, { startedWorld: run.attempt.startedWorld, kills: run.kills, escapes: run.escapes }, worldNow)) {
        await this.#win(agentId, run, worldNow);
      } else if (this.clock() >= run.deadline) {
        run.finishing = true;
        this.#running.delete(agentId);
        this.#log(run, 'end', { how: 'deadline' });
        await this.#finish(run, 'failed', 'deadline');
        this.live.notify(agentId, `Challenge ${run.attempt.challengeId} ran out of time.`);
      }
    }
  }

  /** Every half minute: unwon challenges past deadline and grace refund to their creators. */
  async sweep(): Promise<void> {
    const due = await this.store.dueRefunds(new Date(this.clock()), GRACE_SECONDS + REFUND_MARGIN_SECONDS);
    for (const c of due) {
      for (const [agentId, run] of this.#running) if (run.attempt.challengeId === c.id) { run.finishing = true; this.#running.delete(agentId); }
      await this.store.endChallengeAttempts(c.id, 'deadline', this.world.now());
      await this.store.setStatus(c.id, ['open', 'unrecognised', 'unpaid'], 'refunding');
      await this.store.enqueueOp('refund', { challengeId: c.id }, {});
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  async #win(agentId: string, run: Running, worldNow: number): Promise<void> {
    run.finishing = true;
    if (!run.endLogged) { this.#log(run, 'end', { how: 'goal_met', worldTime: worldNow }); run.endLogged = true; }
    let challenge: Challenge, won: boolean;
    try {
      await this.#flush();
      challenge = (await this.store.challenge(run.attempt.challengeId))!;
      const record = resultRecord(challenge, run.attempt, await this.store.log(run.attempt.id), worldNow);
      won = await this.store.win({ challengeId: challenge.id, attemptId: run.attempt.id, endedWorld: worldNow, resultRecord: record,
        resultHash: keccak256(toBytes(record)), winner: run.attempt.payoutWallet });
    } catch (error) {
      // Keep the win: the next tick tries to record it again.
      run.finishing = false;
      console.error('[challenges] recording a win failed; retrying', (error as Error).message);
      return;
    }
    this.#running.delete(agentId);
    if (!won) {
      await this.store.endAttempt(run.attempt.id, 'void', 'challenge_closed', worldNow);
      this.live.notify(agentId, `You met the goal of challenge ${challenge.id}, but it had already closed.`);
      return;
    }
    this.live.notify(agentId, `You won challenge ${challenge.id}! The prize is being paid to ${run.attempt.payoutWallet}.`);
    // Everyone else on this challenge has lost it; their animals stay theirs to play on.
    for (const [other, r] of [...this.#running]) {
      if (r.attempt.challengeId !== challenge.id) continue;
      r.finishing = true;
      this.#running.delete(other);
      this.live.notify(other, `Challenge ${challenge.id} was won by another player.`);
    }
  }

  async #finish(run: Running, status: 'failed' | 'void', reason: string): Promise<void> {
    try {
      await this.#flush();
      await this.store.endAttempt(run.attempt.id, status, reason, this.world.now());
    } catch (error) { console.error('[challenges] ending an attempt failed', (error as Error).message); }
  }

  #holds(agentId: string, animalId: string): boolean {
    return this.live.avatars.get(agentId)?.animalId === animalId;
  }

  #log(run: Running, kind: string, data: Record<string, unknown>): void {
    // Commands beyond the cap are dropped; hunts, starts and ends are always kept.
    if (run.logged >= MAX_LOG_ENTRIES && kind === 'command') return;
    run.logged++;
    this.#pending.push({ attemptId: run.attempt.id, entry: { at: new Date(this.clock()), kind, data } });
  }

  async #flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    const byAttempt = new Map<string, LogEntry[]>();
    for (const { attemptId, entry } of batch) byAttempt.set(attemptId, [...(byAttempt.get(attemptId) ?? []), entry]);
    for (const [attemptId, entries] of byAttempt) await this.store.appendLog(attemptId, entries);
  }
}

/**
 * The public record of a winning attempt. Its keccak256 is the resultHash written on chain, so
 * anyone can fetch the record, hash it and compare.
 */
export function resultRecord(challenge: Challenge, attempt: Attempt, log: LogEntry[], endedWorld: number): string {
  return JSON.stringify({
    kind: 'wildsentia-challenge-result', version: 1,
    contract: challenge.contract, challengeId: challenge.id, rulesHash: challenge.rulesHash, terms: challenge.terms,
    attemptId: attempt.id, agentId: attempt.agentId, animalId: attempt.animalId, payoutWallet: attempt.payoutWallet,
    startedWorld: attempt.startedWorld, endedWorld: Math.floor(endedWorld),
    log: log.map((e) => ({ at: e.at.toISOString(), kind: e.kind, data: e.data })),
  });
}

export const recordHash = (record: string): Hex => keccak256(toBytes(record));
