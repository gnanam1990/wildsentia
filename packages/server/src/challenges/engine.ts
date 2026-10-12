import { keccak256, toBytes } from 'viem';
import type { CommandRecord, EndedLife, HuntOutcome, LiveLayer, WorldPort } from '../live/liveLayer.js';
import { goalMet, leastRealMs, progressOf } from './goals.js';
import { RuleWatch, type RuleView } from './rules.js';
import type { Attempt, AttemptStatus, Challenge, ChallengeStore, Hex, LogEntry } from './store.js';
import { REACH_MIN_START_M, describeRule, type ChallengeTerms } from './terms.js';

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
/** How many attempts one agent may make at one challenge (each is recorded on chain). */
export const MAX_ATTEMPTS_PER_CHALLENGE = 3;
/** How long an agent waits on a challenge's list for a free animal before it is dropped. */
export const WAIT_MS = 30 * 60_000;
/** At most this many nearby animals are looked through for kin (the herd rule)... */
const KIN_SEARCH_LIMIT = 400;
/** ...as far beyond the herd distance as observe looks: how far an animal's shown position can be from its saved one. */
const KIN_SEARCH_SLACK_M = 900;

export interface Player { agentId: string; name: string; wallet: string | null; walletProven: boolean }
export type AcceptResult =
  | { ok: true; queued: false; attemptId: string; animalId: string }
  | { ok: true; queued: true; position: number; until: string }
  | { ok: false; status: number; error: string };

interface Running {
  attempt: Attempt; terms: ChallengeTerms; deadline: number; kills: number; escapes: number; logged: number; finishing: boolean;
  watch: RuleWatch;
  /** When the rules were last checked (ms): a sprint since then breaks "never run". */
  checkedAt: number;
  /** A rule a command broke, judged on the next tick. */
  broken?: string;
  /** The goal-met entry is logged once, even if recording the win has to be retried. */
  endLogged?: boolean;
  /** An authoritative, timely observation is immutable across asynchronous writes and retries. */
  completed?: { at: number; world: number; kills: number; escapes: number };
}
interface Waiter { player: Player; since: number; terms: ChallengeTerms }

/** WildsentiaAttempts.Outcome for each way an attempt ends. */
const OUTCOME: Record<Exclude<AttemptStatus, 'running'>, 1 | 2 | 3> = { met: 1, failed: 2, void: 3 };

export class ChallengeEngine {
  readonly #running = new Map<string, Running>();
  #pending: Array<{ attemptId: string; entry: LogEntry }> = [];
  /** Attempts ended by a live-layer hook, still being written; the next tick waits for them. */
  #ending: Array<Promise<void>> = [];
  /** The log write under way, if any (see #flush). */
  #flushing: Promise<void> = Promise.resolve();
  /** Attempts whose end could not be written yet (a database blip); retried every tick. */
  #unfinished: Array<{ run: Running; status: 'failed' | 'void'; reason: string; endedWorld: number }> = [];
  /** False until restore() has run (and the hooks are wired): no attempt starts before then. */
  #ready = false;
  /**
   * Each challenge's waiting list, first come first served. Kept in memory: after a restart the
   * agents accept again.
   */
  readonly #waiting = new Map<number, Waiter[]>();

  constructor(private readonly store: ChallengeStore, private readonly live: LiveLayer, private readonly world: WorldPort,
    private readonly clock: () => number = Date.now,
    private readonly options: { recordOnChain?: boolean; feedback?: { siteUrl: string } | undefined; worldHoursPerRealHour?: number } = {}) {}

  /** True when an attempt started now could not meet the goal before the deadline. */
  #tooLate(c: Challenge): boolean {
    const speed = this.options.worldHoursPerRealHour;
    return !!speed && !!c.terms && this.clock() + leastRealMs(c.terms, speed) > c.deadline.getTime();
  }

  /** Picks up attempts still running before a restart; one whose animal was lost is void. */
  async restore(): Promise<void> {
    for (const attempt of await this.store.runningAttempts()) {
      const avatar = this.live.avatars.get(attempt.agentId);
      const challenge = await this.store.challenge(attempt.challengeId);
      const log = await this.store.log(attempt.id);
      const completion = log.find(e => e.kind === 'end' && e.data.how === 'goal_met'
        && typeof e.data.completedAt === 'number' && e.data.completedAt < (challenge?.deadline.getTime() ?? 0)
        && typeof e.data.worldTime === 'number');
      if (((!avatar || avatar.animalId !== attempt.animalId) && !completion) || !challenge?.terms) {
        await this.store.endAttempt(attempt.id, 'void', 'lost_in_restart', this.world.now());
        continue;
      }
      const logged = log.length;
      this.#running.set(attempt.agentId, { attempt, terms: challenge.terms, deadline: challenge.deadline.getTime(),
        kills: attempt.kills, escapes: attempt.escapes, logged, finishing: false, watch: new RuleWatch(challenge.terms.rules),
        checkedAt: this.clock(), ...(completion ? { endLogged: true,
          completed: { at: Number(completion.data.completedAt), world: Number(completion.data.worldTime),
            kills: Number(completion.data.kills ?? attempt.kills), escapes: Number(completion.data.escapes ?? attempt.escapes) } } : {}) });
    }
    this.#ready = true;
  }

  async accept(player: Player, challengeId: number): Promise<AcceptResult> {
    if (!this.#ready) return { ok: false, status: 503, error: 'challenges_starting' };
    const c = await this.store.challenge(challengeId);
    if (!c) return { ok: false, status: 404, error: 'not_found' };
    if (c.status !== 'open' || !c.terms) return { ok: false, status: 409, error: 'not_open' };
    if (this.clock() >= c.deadline.getTime()) return { ok: false, status: 409, error: 'deadline_passed' };
    if (this.#tooLate(c)) return { ok: false, status: 409, error: 'too_late_to_finish' };
    if (!player.wallet || !player.walletProven) return { ok: false, status: 403, error: 'payout_wallet_required' };
    // Not from the creator's wallet, nor the creator's own identity (whatever wallet it links later).
    if (player.wallet.toLowerCase() === c.creatorWallet || (c.creatorAgentId && c.creatorAgentId === player.agentId))
      return { ok: false, status: 403, error: 'creator_cannot_play' };
    if (this.#running.has(player.agentId)) return { ok: false, status: 409, error: 'already_in_a_challenge' };
    const waitingOn = this.waitingOf(player.agentId);
    if (waitingOn) {
      if (waitingOn.challengeId !== challengeId) return { ok: false, status: 409, error: 'already_waiting' };
      return { ok: true, queued: true, position: waitingOn.position, until: waitingOn.until };
    }
    if (this.live.avatars.has(player.agentId)) return { ok: false, status: 409, error: 'release_your_animal_first' };
    if (await this.store.attemptCount(challengeId, player.agentId) >= MAX_ATTEMPTS_PER_CHALLENGE)
      return { ok: false, status: 409, error: 'no_attempts_left' };
    // Agents already waiting go first; otherwise a free animal starts the attempt now.
    const free = this.#waiting.has(challengeId) ? null : this.#freeAnimal(c.terms);
    if (free) return this.#start(player, c, free);
    const queue = this.#waiting.get(challengeId) ?? [];
    queue.push({ player, since: this.clock(), terms: c.terms });
    this.#waiting.set(challengeId, queue);
    this.live.notify(player.agentId, `No free ${c.terms.speciesId} for challenge ${challengeId} yet: you are number ${queue.length} on its waiting list.`);
    return { ok: true, queued: true, position: queue.length, until: new Date(this.clock() + WAIT_MS).toISOString() };
  }

  /**
   * True when a challenge's player has waited for this species at least since `since` and a free
   * animal suits their challenge: the next tick starts their attempt with it.
   */
  holdsFreed(speciesId: string, since: number): boolean {
    const now = this.clock();
    for (const queue of this.#waiting.values()) {
      for (const w of queue) {
        if (w.terms.speciesId === speciesId && w.since <= since && now - w.since < WAIT_MS && this.#freeAnimal(w.terms)) return true;
      }
    }
    return false;
  }

  /** Where the agent waits, if it is on a waiting list. */
  waitingOf(agentId: string): { challengeId: number; position: number; until: string } | null {
    for (const [challengeId, queue] of this.#waiting) {
      const i = queue.findIndex((w) => w.player.agentId === agentId);
      if (i >= 0) return { challengeId, position: i + 1, until: new Date(queue[i]!.since + WAIT_MS).toISOString() };
    }
    return null;
  }

  /** Takes the agent off any waiting list. */
  leave(agentId: string): boolean {
    const waiting = this.waitingOf(agentId);
    if (waiting) this.#dropWaiter(waiting.challengeId, agentId);
    return !!waiting;
  }

  /** A free animal of the challenge's species that may start it: inside its zone, far enough from its target. */
  #freeAnimal(terms: ChallengeTerms): string | null {
    const zone = terms.rules.find((r) => r.type === 'zone');
    const herd = terms.rules.find((r) => r.type === 'herd');
    let best: { id: string; kin: number } | null = null;
    // Judged where possess places the animal (its saved position), over every free one of the species.
    for (const a of this.world.candidates(terms.speciesId, Number.MAX_SAFE_INTEGER)) {
      if (this.live.wild.has(a.id)) continue;
      const at = a.position;
      if (zone && zone.type === 'zone' && Math.hypot(at.x - zone.x, at.z - zone.z) > zone.radiusM) continue;
      if (terms.template === 'reach' && Math.hypot(at.x - terms.x, at.z - terms.z) < REACH_MIN_START_M) continue;
      if (!herd || herd.type !== 'herd') return a.id;
      // Under the herd rule, start with one that is with its kind: a lone animal would fail through no fault of the player.
      const kin = this.#nearestKin(a.id, terms.speciesId, at, herd.maxDistanceM);
      if (kin <= herd.maxDistanceM) return a.id;
      if (!best || kin < best.kin) best = { id: a.id, kin };
    }
    return best?.id ?? null;
  }

  /** How far the nearest other live animal of the species is from a point, by saved positions (Infinity if none near). */
  #nearestKin(animalId: string, speciesId: string, at: { x: number; z: number }, withinM: number): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (const k of this.world.nearby(at.x, at.z, withinM + KIN_SEARCH_SLACK_M, KIN_SEARCH_LIMIT)) {
      if (k.id === animalId || k.speciesId !== speciesId || !k.alive) continue;
      nearest = Math.min(nearest, Math.hypot(k.position.x - at.x, k.position.z - at.z));
    }
    return nearest;
  }

  async #start(player: Player, c: Challenge, animalId: string): Promise<AcceptResult> {
    const terms = c.terms!;
    // A named free animal, never the species queue: a queued agent would get it later outside the challenge.
    const taken = this.live.possess(player.agentId, player.name, { animalId });
    if (!taken.ok) return { ok: false, status: 409, error: taken.reason };
    const animal = this.world.animal(animalId)!;
    const startState = { animalId: animal.id, speciesId: animal.speciesId, lifeStage: animal.lifeStage,
      position: { x: taken.avatar.x, z: taken.avatar.z }, drives: animal.drives };
    let attempt: Attempt;
    try {
      attempt = await this.store.startAttempt({ challengeId: c.id, agentId: player.agentId, animalId: animal.id,
        payoutWallet: player.wallet!, startedWorld: this.world.now(), startState });
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
    const run: Running = { attempt, terms, deadline: c.deadline.getTime(), kills: 0, escapes: 0, logged: 0, finishing: false,
      watch: new RuleWatch(terms.rules), checkedAt: this.clock() };
    this.#running.set(player.agentId, run);
    this.#log(run, 'start', { challengeId: c.id, ...startState, worldTime: attempt.startedWorld });
    const rules = terms.rules.length ? ` Rules: ${terms.rules.map(describeRule).join('; ')}.` : '';
    this.live.notify(player.agentId, `Challenge ${c.id} started.${rules}`);
    return { ok: true, queued: false, attemptId: attempt.id, animalId: animal.id };
  }

  /** The player's current attempt, for observe. */
  progressOf(agentId: string): { challengeId: number; attemptId: string; goal: Omit<ChallengeTerms, 'briefing'>; rules: string[]; briefing: string;
    progress: { done: number; of: number; unit: string }; deadline: string } | null {
    const run = this.#running.get(agentId);
    if (!run) return null;
    const position = this.live.avatars.get(agentId) ?? null;
    // The creator's briefing is given apart from the goal, so it can be labelled as theirs.
    const { briefing: _briefing, ...goal } = run.terms;
    return { challengeId: run.attempt.challengeId, attemptId: run.attempt.id, goal,
      rules: run.terms.rules.map(describeRule), briefing: run.terms.briefing,
      progress: progressOf(run.terms, { startedWorld: run.attempt.startedWorld, kills: run.kills, escapes: run.escapes,
        position: position && { x: position.x, z: position.z } }, this.world.now()),
      deadline: new Date(run.deadline).toISOString() };
  }

  // ---- live layer hooks (synchronous; database work follows on the next tick) ----------

  onCommand(record: CommandRecord): void {
    const run = this.#running.get(record.agentId);
    if (!run || run.completed) return;
    this.#log(run, 'command', { command: record.command, ...record.args });
    const broken = run.watch.commandBreaks(record.command, record.args);
    if (broken && !run.broken) run.broken = broken;
  }

  onHunt(hunt: HuntOutcome): void {
    // Only the attempt's own animal counts, whoever steers it now.
    const hunter = hunt.predatorAgentId ? this.#running.get(hunt.predatorAgentId) : undefined;
    if (hunter && !hunter.completed && this.clock() < hunter.deadline && hunter.attempt.animalId === hunt.predatorId) {
      if (hunt.killed) hunter.kills++;
      this.#log(hunter, 'hunt', { as: 'predator', predatorId: hunt.predatorId, preyId: hunt.preyId, killed: hunt.killed });
      this.#observeGoal(hunt.predatorAgentId!, hunter);
    }
    const prey = hunt.preyAgentId ? this.#running.get(hunt.preyAgentId) : undefined;
    if (prey && !prey.completed && this.clock() < prey.deadline && prey.attempt.animalId === hunt.preyId) {
      if (!hunt.killed) prey.escapes++;
      this.#log(prey, 'hunt', { as: 'prey', predatorId: hunt.predatorId, preyId: hunt.preyId, killed: hunt.killed });
      this.#observeGoal(hunt.preyAgentId!, prey);
    }
  }

  onEnded(life: EndedLife): void {
    const run = this.#running.get(life.agentId);
    if (!run || run.finishing || run.completed || run.attempt.animalId !== life.animalId) return;
    run.finishing = true;
    this.#running.delete(life.agentId);
    this.#log(run, 'end', { how: life.how });
    // Giving birth hands the animal back to the wild: not the player's failure, so the attempt is void.
    this.#ending.push(this.#finish(run, life.how === 'birth' ? 'void' : 'failed', life.how));
  }

  /** Sample eligibility synchronously, before any database await can cross the deadline. */
  #observeGoal(agentId: string, run: Running): void {
    const at = this.clock();
    if (run.completed || run.finishing || at >= run.deadline || !this.#holds(agentId, run.attempt.animalId)) return;
    const avatar = this.live.avatars.get(agentId)!;
    const world = this.world.now();
    if (!goalMet(run.terms, { startedWorld: run.attempt.startedWorld, kills: run.kills, escapes: run.escapes,
      position: { x: avatar.x, z: avatar.z } }, world)) return;
    const broken = run.broken ?? run.watch.check(this.#view(agentId), at);
    run.checkedAt = at;
    if (broken) { run.broken = broken; return; }
    run.completed = { at, world, kills: run.kills, escapes: run.escapes };
  }

  /** Called after each live movement tick: observation is independent of the slower DB timer. */
  observeGoals(): void {
    for (const [agentId, run] of this.#running) this.#observeGoal(agentId, run);
  }

  // ---- timers -------------------------------------------------------------------------------

  /** Once a second: write logs and progress, check goals and deadlines. */
  async tick(): Promise<void> {
    this.observeGoals();
    const ending = this.#ending;
    this.#ending = [];
    await Promise.all(ending);
    for (const u of this.#unfinished.splice(0)) await this.#finish(u.run, u.status, u.reason, u.endedWorld);
    await this.#flush();
    for (const [agentId, run] of [...this.#running]) {
      if (run.finishing) continue;
      if (run.completed) { await this.#win(agentId, run, run.completed.world); continue; }
      // Never judge a goal for an animal the player no longer holds, whatever the hooks said.
      if (!this.#holds(agentId, run.attempt.animalId)) {
        run.finishing = true;
        this.#running.delete(agentId);
        this.#log(run, 'end', { how: 'animal_lost' });
        await this.#finish(run, 'failed', 'animal_lost');
        continue;
      }
      const broken = run.broken ?? run.watch.check(this.#view(agentId), this.clock());
      run.checkedAt = this.clock();
      if (broken) {
        run.finishing = true;
        this.#running.delete(agentId);
        this.#log(run, 'end', { how: broken });
        await this.#finish(run, 'failed', broken);
        this.live.notify(agentId, `You broke a rule of challenge ${run.attempt.challengeId}, so this attempt is over. The animal is still yours.`);
        continue;
      }
      if (run.kills !== run.attempt.kills || run.escapes !== run.attempt.escapes) {
        await this.store.saveProgress(run.attempt.id, run.kills, run.escapes);
        run.attempt = { ...run.attempt, kills: run.kills, escapes: run.escapes };
      }
      if (this.clock() >= run.deadline) {
        run.finishing = true;
        this.#running.delete(agentId);
        this.#log(run, 'end', { how: 'deadline' });
        await this.#finish(run, 'failed', 'deadline');
        this.live.notify(agentId, `Challenge ${run.attempt.challengeId} ran out of time.`);
      }
    }
    await this.#serveWaiting();
  }

  /** Starts the next waiting agent's attempt when an animal comes free; drops waits that ran out. */
  async #serveWaiting(): Promise<void> {
    for (const challengeId of [...this.#waiting.keys()]) {
      // The list is read afresh after every await: accept() may add to it meanwhile.
      const queue = () => this.#waiting.get(challengeId) ?? [];
      const now = this.clock();
      for (const w of queue().filter((x) => now - x.since >= WAIT_MS)) {
        this.#dropWaiter(challengeId, w.player.agentId);
        this.live.notify(w.player.agentId, `No animal came free for challenge ${challengeId} in time; you are off its waiting list.`);
      }
      if (queue().length === 0) continue;
      const c = await this.store.challenge(challengeId);
      if (!c?.terms || c.status !== 'open' || this.clock() >= c.deadline.getTime() || this.#tooLate(c)) {
        for (const w of queue()) {
          this.#dropWaiter(challengeId, w.player.agentId);
          this.live.notify(w.player.agentId, `Challenge ${challengeId} closed while you waited.`);
        }
        continue;
      }
      // An agent that took another animal meanwhile has stopped waiting.
      for (const w of queue()) {
        if (!this.#running.has(w.player.agentId) && !this.live.avatars.has(w.player.agentId)) continue;
        this.#dropWaiter(challengeId, w.player.agentId);
        this.live.notify(w.player.agentId, `You took another animal, so you are off the waiting list for challenge ${challengeId}.`);
      }
      const head = queue()[0];
      const free = head ? this.#freeAnimal(c.terms) : null;
      if (!head || !free) continue;
      this.#dropWaiter(challengeId, head.player.agentId);
      let started: AcceptResult;
      try { started = await this.#start(head.player, c, free); }
      catch (error) {
        console.error('[challenges] starting a waiting attempt failed', (error as Error).message);
        started = { ok: false, status: 500, error: 'could_not_start' };
      }
      if (started.ok) {
        this.live.notify(head.player.agentId, `An animal came free: your attempt at challenge ${challengeId} has started.`);
      } else if (started.error === 'cooldown') {
        // Too soon after a death to take an animal: keep its place at the front and try again.
        this.#waiting.set(challengeId, [head, ...queue()]);
      } else {
        this.live.notify(head.player.agentId, `Your attempt at challenge ${challengeId} could not start (${started.error}); you are off its waiting list.`);
      }
    }
  }

  #dropWaiter(challengeId: number, agentId: string): void {
    const queue = this.#waiting.get(challengeId);
    if (!queue) return;
    const rest = queue.filter((w) => w.player.agentId !== agentId);
    if (rest.length) this.#waiting.set(challengeId, rest); else this.#waiting.delete(challengeId);
  }

  /**
   * Every few seconds: gives each ended attempt its record (the hash of its log), and when the
   * attempts contract is set, queues each attempt's start and end to be written on chain.
   */
  async recordAttempts(): Promise<void> {
    await this.#flush();
    for (const a of await this.store.endedWithoutRecord(50)) {
      const challenge = await this.store.challenge(a.challengeId);
      if (!challenge) continue;
      const record = resultRecord(challenge, a, await this.store.log(a.id), a.endedWorld ?? this.world.now());
      await this.store.saveRecord(a.id, record, recordHash(record));
    }
    // ERC-8004: each met or failed attempt by a player with an identity leaves one feedback, pointing at its record.
    const feedback = this.options.feedback;
    if (feedback) {
      for (const a of await this.store.attemptsForFeedback(50)) {
        // feedbackURI serves exactly the record whose keccak256 is feedbackHash (ERC-8004); wallet is checked against the identity's owner when sent.
        await this.store.enqueueOp('reputation', { attemptId: a.id, challengeId: a.challengeId }, { agentId: a.erc8004AgentId,
          value: a.status === 'met' ? 100 : 0, tag2: a.status, wallet: a.payoutWallet, endpoint: `${feedback.siteUrl}/challenges.html?id=${a.challengeId}`,
          feedbackURI: `${feedback.siteUrl}/api/challenges/${a.challengeId}/attempts/${a.id}/record`, feedbackHash: a.resultHash });
      }
    }
    if (!this.options.recordOnChain) return;
    for (const a of await this.store.attemptsToRecord(50)) {
      if (!a.startQueued) await this.store.enqueueOp('record_start', { attemptId: a.id, challengeId: a.challengeId }, { player: a.payoutWallet });
      if (a.status !== 'running' && a.resultHash && !a.endQueued)
        await this.store.enqueueOp('record_end', { attemptId: a.id, challengeId: a.challengeId }, { outcome: OUTCOME[a.status], logHash: a.resultHash });
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
    const completed = run.completed!;
    // Persistence order cannot award a later observed completion ahead of a buffered earlier one.
    if ([...this.#running.values()].some(other => other !== run && other.attempt.challengeId === run.attempt.challengeId
      && other.completed && other.completed.at < completed.at)) return;
    run.finishing = true;
    if (!run.endLogged) { this.#log(run, 'end', { how: 'goal_met', worldTime: worldNow, completedAt: completed.at,
      kills: completed.kills, escapes: completed.escapes }); run.endLogged = true; }
    let challenge: Challenge, won: boolean;
    try {
      await this.#flush();
      challenge = (await this.store.challenge(run.attempt.challengeId))!;
      const record = resultRecord(challenge, { ...run.attempt, kills: completed.kills, escapes: completed.escapes, status: 'met', endReason: 'goal_met' }, await this.store.log(run.attempt.id), worldNow);
      won = await this.store.win({ challengeId: challenge.id, attemptId: run.attempt.id, endedWorld: worldNow, resultRecord: record,
        resultHash: keccak256(toBytes(record)), winner: run.attempt.payoutWallet, completedAt: new Date(completed.at),
        kills: completed.kills, escapes: completed.escapes });
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

  async #finish(run: Running, status: 'failed' | 'void', reason: string, endedWorld = this.world.now()): Promise<void> {
    try {
      await this.#flush();
      await this.store.endAttempt(run.attempt.id, status, reason, endedWorld);
    } catch (error) {
      // Never leave it running in the database: the next tick tries again, with the same end time.
      console.error('[challenges] ending an attempt failed; trying again', (error as Error).message);
      this.#unfinished.push({ run, status, reason, endedWorld });
    }
  }

  /** What the rules are judged on: where the animal is, how it moves, how near its kin are. */
  #view(agentId: string): RuleView {
    const avatar = this.live.avatars.get(agentId)!;
    const run = this.#running.get(agentId)!;
    let nearestKinM: number | null = null;
    const herd = run.watch.herdDistance();
    if (herd !== null) {
      // Saved positions can be an hour's travel from where animals are shown: search wide, then judge where they are now.
      for (const a of this.world.nearby(avatar.x, avatar.z, herd + KIN_SEARCH_SLACK_M, KIN_SEARCH_LIMIT)) {
        if (a.id === avatar.animalId || a.speciesId !== avatar.speciesId || !a.alive) continue;
        // Where it is now (an agent's animal, a live chase or the route as played), as observe shows it.
        const at = this.live.positionOf(a.id) ?? a.position;
        const d = Math.hypot(at.x - avatar.x, at.z - avatar.z);
        if (nearestKinM === null || d < nearestKinM) nearestKinM = d;
      }
    }
    return { position: { x: avatar.x, z: avatar.z }, gait: avatar.gait, moving: avatar.moving, nearestKinM,
      sprinted: (avatar.sprintedAt ?? -Infinity) >= run.checkedAt };
  }

  #holds(agentId: string, animalId: string): boolean {
    return this.live.avatars.get(agentId)?.animalId === animalId;
  }

  #log(run: Running, kind: string, data: Record<string, unknown>): void {
    // Commands beyond the cap are dropped; hunts, starts and ends are always kept. Once an attempt is
    // finishing only its end is logged, so the hashed record and the public log stay the same.
    if (run.logged >= MAX_LOG_ENTRIES && kind === 'command') return;
    if (run.finishing && kind !== 'end') return;
    run.logged++;
    this.#pending.push({ attemptId: run.attempt.id, entry: { at: new Date(this.clock()), kind, data } });
  }

  /**
   * Writes the pending log. Writes run one after another: a win reads the log back to hash it as
   * soon as its own flush returns, so no earlier batch may still be on its way.
   */
  #flush(): Promise<void> {
    const next = this.#flushing.then(() => this.#flushNow());
    this.#flushing = next.catch(() => {});
    return next;
  }

  async #flushNow(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    const byAttempt = new Map<string, LogEntry[]>();
    for (const { attemptId, entry } of batch) byAttempt.set(attemptId, [...(byAttempt.get(attemptId) ?? []), entry]);
    const left = [...byAttempt];
    try {
      while (left.length) {
        const [attemptId, entries] = left[0]!;
        await this.store.appendLog(attemptId, entries);
        left.shift();
      }
    } finally {
      // Entries not written go back first in line, in order: a record is hashed over the whole log.
      if (left.length) this.#pending = [...left.flatMap(([attemptId, entries]) => entries.map((entry) => ({ attemptId, entry }))), ...this.#pending];
    }
  }
}

/**
 * The public record of an ended attempt. Its keccak256 is the hash written on chain (the
 * winner's resultHash, and every attempt's logHash), so anyone can fetch it, hash it and compare.
 */
export function resultRecord(challenge: Challenge, attempt: Attempt, log: LogEntry[], endedWorld: number): string {
  return JSON.stringify({
    kind: 'wildsentia-challenge-result', version: 1,
    contract: challenge.contract, challengeId: challenge.id, rulesHash: challenge.rulesHash, terms: challenge.terms,
    attemptId: attempt.id, agentId: attempt.agentId, animalId: attempt.animalId, payoutWallet: attempt.payoutWallet,
    outcome: attempt.status, reason: attempt.endReason,
    startedWorld: attempt.startedWorld, endedWorld: Math.floor(endedWorld),
    log: log.map((e) => ({ at: e.at.toISOString(), kind: e.kind, data: e.data })),
  });
}

export const recordHash = (record: string): Hex => keccak256(toBytes(record));
