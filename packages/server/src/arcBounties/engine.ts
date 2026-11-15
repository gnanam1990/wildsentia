import { randomBytes, randomInt } from 'node:crypto';
import { canHunt, type World } from '@vana/sim';
import { patchCentre, regionOfPatch, regionPatchIds } from '@vana/shared';
import { getAddress, type Hex, keccak256, stringToHex } from 'viem';
import { PROTECTED_SPECIES } from '../bounties/engine.js';
import { type BountyCall, type BountyChain, EXTERNAL_REF, targetCommit } from './chain.js';
import { idempotencyUuid } from './circle.js';
import type { Link } from './funding.js';
import type { ArcBounty, ArcBountyStore, ArcDecision } from './store.js';

/**
 * Congo bounties paid on Arc (docs/2026-10-19-congo-arc-bounties-design.md). The server picks a
 * prey animal at random among those agents steer, reserves USDC for it on chain under a secret
 * commit, and tells only the prey's agent. If an agent's predator kills it before the deadline, that
 * agent's wallet is paid; if the prey's agent keeps it alive to the deadline, the prey's wallet is;
 * otherwise the money goes back to the pool. Every decision is recorded, hashed and revealed on chain.
 */

/** A real elapsed time this many times the window's is an outage; the chain's expiry allows for it. */
export const EXPIRY_FACTOR = 3;
/** The longest a bounty may stay open on chain (WildsentiaBounties.MAX_DURATION is 30 days). */
const MAX_OPEN_MS = 29 * 86_400_000;
/** A transaction not mined after this long is sent again (the contract refuses a second decision). */
const RESEND_AFTER_MS = 120_000;
/** The network every signed-in person once shared, before sign-in recorded theirs (accounts/store.ts). */
export const LEGACY_HUMAN_NETWORK = 'human';
const PREDATOR_WITHIN_M = 15_000;
/** An external signer's transaction is checked every 3 s (Circle's own sample) for up to 30 s, then left to processPending. */
export let EXTERNAL_POLL_MS = 3_000;
const EXTERNAL_POLLS = 10;
/** Tests: poll faster. */
export function setExternalPollMs(ms: number): void { EXTERNAL_POLL_MS = ms; }

export interface ArcBountyPorts {
  world: () => World;
  /** The hour being played, which trails the world's clock by up to an hour (a live kill may still beat the deadline). */
  played: () => number;
  /** World hours per real hour. */
  rate: () => number;
  /** The animals agents steer now. */
  steered: () => Iterable<{ agentId: string; animalId: string; speciesId: string; agentName?: string }>;
  steererOf: (animalId: string) => string | null;
  /** An agent's wallet, if it proved it owns it. */
  wallet: (agentId: string) => Promise<string | null>;
  /**
   * The keyed hash of the network an agent registered from. A hunter from the prey's own network
   * never wins its bounty, and a bounty needs a hunter from another: one person running both agents
   * would otherwise feed their own prey to their own predator. A weak check (a second network is
   * cheap), the first of the identity limits the design names.
   */
  network: (agentId: string) => Promise<string | null>;
  /** Testnet demos only: both demo agents run from one machine (VANA_ARC_BOUNTIES_SAME_NETWORK_OK=1). */
  sameNetworkOk?: boolean;
  /**
   * Whether two wallets are linked by money on chain (funding.ts): one paid the other, or one
   * address funded both, or both cashed out to one. A hunter linked so to the prey's wallet is never
   * paid, and does not count as the hunter near a random bounty. Throws when it cannot tell yet.
   * None: the check is off.
   */
  fundingLinked?: (a: string, b: string) => Promise<Link>;
  /**
   * Who owns an agent, for payouts: one person (on mainnet, their X account, at least 30 days old),
   * or null when the agent may not be paid. Agents of one owner never win each other's bounties, and
   * an owner's winnings are capped (`ownerDailyCapAtomic`). None: every agent is its own owner.
   */
  owner?: (agentId: string) => Promise<string | null>;
  /** The most USDC (6-decimal units) one owner may win in any 24 hours; a win past it goes back to the pool. None: no cap. */
  ownerDailyCapAtomic?: bigint | null;
  /**
   * A random bounty goes only on a prey hidden among at least this many prey of its species in its
   * region that could carry one too, from as many networks (itself included), since the public list
   * of steered animals and the bounty's species and region would otherwise point at it. Default 3;
   * 1 turns the check off.
   */
  randomCrowd?: number;
  notify: (agentId: string, text: string) => void;
  /** The recorded events of these animals between two world times, for the bounty's record. */
  eventsOf: (animalIds: string[], from: number, to: number) => Promise<unknown[]>;
  explorer?: string | null;
  /**
   * The most USDC (6-decimal units) bounties may reserve in any 24 hours, however they are dropped:
   * a stolen admin token, or a bug, cannot spend the pool faster. None: no cap.
   */
  dailyCapAtomic?: bigint | null;
  /**
   * Told when a bounty goes live on chain and when it is paid or returned, with what the public may
   * know (never a live bounty's target): for alerts and the public board.
   */
  announce?: (event: { kind: 'published' | 'settled'; bounty: ArcBounty }) => void;
}

/** Why a decision paid nobody though someone met its terms (in the record, hashed on chain). */
export type Refusal = { reason: 'funding_linked'; how: string; via: string } | { reason: 'identity' | 'same_owner' | 'owner_cap' };

export type PublishResult = { ok: true; bounty: ArcBounty } | { ok: false; reason: string };

export class ArcBountyEngine {
  #queue: Promise<unknown> = Promise.resolve();
  /** Whether this key may publish (it is the contract's evaluator, and USDC counts 6 decimals), once checked. */
  #identity: { ok: true } | { ok: false; reason: string } | null = null;
  /** Bounties whose publication or result the steering agents were told of (once each, while the server runs). */
  readonly #told = new Set<string>();
  constructor(private readonly store: ArcBountyStore, private readonly chain: BountyChain, private readonly ports: ArcBountyPorts) {}

  /** Chain work and decisions one at a time: the evaluator's nonce, and one decision per bounty. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Species that can hunt this one. */
  eligiblePredators(speciesId: string): string[] {
    const world = this.ports.world(), prey = world.species.get(speciesId);
    if (!prey) return [];
    const sample = { massKg: prey.body.adultMassKg, lifeStage: 'adult' as const, altitudeM: 0, locomotionMode: 'ground' as const };
    return [...world.species.values()].filter((s) => s.id !== speciesId && canHunt(s, prey, sample)).map((s) => s.id);
  }

  /**
   * The prey animals a bounty could go on now: steered by an agent with a proven wallet, of a
   * species that is hunted and not protected, alive, carrying no bounty, and with a predator an
   * other agent steers within 15 km (`requireHunter`, so the hunt can really happen).
   */
  async candidates(requireHunter = true): Promise<Array<{ agentId: string; animalId: string; speciesId: string; wallet: string; eligible: string[] }>> {
    const world = this.ports.world(), taken = await this.store.liveTargets(), steered = [...this.ports.steered()];
    const out = [];
    for (const s of steered) {
      const animal = world.animal(s.animalId);
      if (!animal?.alive || !animal.position || taken.has(s.animalId) || PROTECTED_SPECIES.has(s.speciesId)) continue;
      const eligible = this.eligiblePredators(s.speciesId);
      if (eligible.length === 0) continue;
      // A prey whose owner may not be paid here could never win its survival half.
      const owner = await this.#ownerOf(s.agentId);
      if (!owner) continue;
      if (requireHunter) {
        let hunter = false;
        for (const h of steered) {
          if (h.agentId === s.agentId || !eligible.includes(h.speciesId)) continue;
          const p = world.animal(h.animalId)?.position;
          if (!p || Math.hypot(p.x - animal.position.x, p.z - animal.position.z) > PREDATOR_WITHIN_M) continue;
          if (await this.#related(h.agentId, s.agentId)) continue;
          const hunterOwner = await this.#ownerOf(h.agentId);
          if (!hunterOwner || hunterOwner === owner) continue;
          // Linked by money, or not known yet: not a hunter from someone else.
          const [hw, pw] = await Promise.all([this.ports.wallet(h.agentId), this.ports.wallet(s.agentId)]);
          const money = await this.#moneyLink(hw, pw);
          if (money === 'unknown' || money.linked) continue;
          hunter = true; break;
        }
        if (!hunter) continue;
      }
      const wallet = await this.ports.wallet(s.agentId);
      if (!wallet) continue;
      out.push({ ...s, wallet, eligible });
    }
    return out;
  }

  /**
   * Whether a kill could be self-dealing: the hunter's agent, or its wallet, is the agent that held
   * the prey at publication or at the kill (wild then, or steered without a proven wallet), or
   * registered from the same network as either.
   */
  async #colluded(b: ArcBounty, killer: string, killerWallet: string): Promise<boolean> {
    for (const holder of new Set([b.targetAgentId, b.killPreyAgentId].filter((a): a is string => !!a))) {
      if (holder === killer || await this.#related(killer, holder)) return true;
      const holderWallet = holder === b.targetAgentId ? b.targetWallet : await this.ports.wallet(holder);
      if (holderWallet && holderWallet.toLowerCase() === killerWallet.toLowerCase()) return true;
    }
    return !!b.targetWallet && b.targetWallet.toLowerCase() === killerWallet.toLowerCase();
  }

  /**
   * Whether the hunter's wallet is linked by money to a wallet that held the prey (at publication or
   * at the kill): 'unknown' while the explorer cannot be read.
   */
  async #fundedTogether(b: ArcBounty, killerWallet: string): Promise<Link | 'unknown'> {
    const holders = new Set<string>();
    if (b.targetWallet) holders.add(b.targetWallet.toLowerCase());
    if (b.killPreyAgentId && b.killPreyAgentId !== b.targetAgentId) {
      const w = await this.ports.wallet(b.killPreyAgentId);
      if (w) holders.add(w.toLowerCase());
    }
    for (const holder of holders) {
      const money = await this.#moneyLink(killerWallet, holder);
      if (money === 'unknown' || money.linked) return money;
    }
    return { linked: false };
  }

  /** An agent's owner, or null when it may not be paid here. */
  async #ownerOf(agentId: string): Promise<string | null> {
    return this.ports.owner ? this.ports.owner(agentId) : `agent:${agentId}`;
  }

  /**
   * Why this agent may not be paid this bounty, or its owner: an owner who may not be paid here, the
   * owner of an agent that held the prey (a hunter only), or one past the daily cap with it.
   */
  async #payableOwner(b: ArcBounty, agentId: string, hunter: boolean): Promise<{ owner: string } | { refused: Refusal }> {
    const owner = await this.#ownerOf(agentId);
    if (!owner) return { refused: { reason: 'identity' } };
    if (hunter) {
      for (const holder of new Set([b.targetAgentId, b.killPreyAgentId].filter((a): a is string => !!a))) {
        if (await this.#ownerOf(holder) === owner) return { refused: { reason: 'same_owner' } };
      }
    }
    const cap = this.ports.ownerDailyCapAtomic;
    if (cap != null && (await this.store.wonSince(owner, new Date(Date.now() - 86_400_000))) + b.amountAtomic > cap) return { refused: { reason: 'owner_cap' } };
    return { owner };
  }

  /** Whether two wallets are linked by money (never, with the check off or in a one-machine testnet demo). */
  async #moneyLink(a: string | null, b: string | null): Promise<Link | 'unknown'> {
    if (!a || !b || !this.ports.fundingLinked || this.ports.sameNetworkOk) return { linked: false };
    try { return await this.ports.fundingLinked(a, b); } catch (error) {
      console.error(`[arc-bounty] funding check unavailable: ${String((error as Error).message ?? error).split('\n')[0]}`);
      return 'unknown';
    }
  }

  /** Whether two agents registered from the same network (unless a testnet demo allows it). */
  async #related(a: string, b: string): Promise<boolean> {
    if (this.ports.sameNetworkOk) return false;
    const [na, nb] = await Promise.all([this.ports.network(a), this.ports.network(b)]);
    // A person who has not signed in since networks were recorded still carries the old shared
    // placeholder: their network is unknown, so a kill involving them is never paid until they do.
    if (na === LEGACY_HUMAN_NETWORK || nb === LEGACY_HUMAN_NETWORK) return true;
    return na !== null && na === nb;
  }

  /**
   * The candidates hidden in a crowd: at least `randomCrowd` prey of their own species in their own
   * region that could carry a bounty as well (steered with a proven wallet, unprotected, carrying
   * none: a hunter cannot rule any of them out), counted once per network, so that one person's
   * agents cannot make a crowd and know the target is the one that is not theirs.
   */
  async #hiddenInCrowd<T extends { animalId: string; speciesId: string }>(candidates: T[]): Promise<T[]> {
    const need = this.ports.randomCrowd ?? 3;
    if (need <= 1) return candidates;
    const world = this.ports.world(), crowd = new Map<string, Set<string>>();
    const keyOf = (animalId: string, speciesId: string): string | null => {
      const animal = world.animal(animalId);
      const region = animal?.alive ? this.regionOf(animal.patchId) : null;
      return region ? `${speciesId}@${region}` : null;
    };
    for (const c of await this.candidates(false)) {
      const key = keyOf(c.animalId, c.speciesId), network = await this.ports.network(c.agentId);
      if (!key) continue;
      const networks = crowd.get(key) ?? new Set<string>();
      networks.add(network && network !== LEGACY_HUMAN_NETWORK ? `net:${network}` : `agent:${c.agentId}`);
      crowd.set(key, networks);
    }
    return candidates.filter((c) => (crowd.get(keyOf(c.animalId, c.speciesId) ?? '')?.size ?? 0) >= need);
  }

  /** Puts a bounty on a prey animal picked at random, and publishes it on chain. */
  publishRandom(p: { amountAtomic: bigint; windowWorldSeconds: number; requireHunter?: boolean }): Promise<PublishResult> {
    return this.#serial(async () => {
      const refused = await this.#terms(p);
      if (refused) return { ok: false, reason: refused };
      const all = await this.candidates(p.requireHunter ?? true);
      if (all.length === 0) return { ok: false, reason: 'no_candidate' };
      const candidates = await this.#hiddenInCrowd(all);
      if (candidates.length === 0) return { ok: false, reason: 'too_few_alike' };
      const pick = candidates[randomInt(candidates.length)]!;
      return this.#create({ animalId: pick.animalId, speciesId: pick.speciesId, agentId: pick.agentId, wallet: pick.wallet, eligible: pick.eligible }, p, 'random');
    });
  }

  /**
   * Whether the operator may drop a bounty on this animal: alive, of a hunted species that is not
   * protected, carrying none already. Who steers it, and whether that agent proved a wallet, says
   * who can win the survival half: a wild animal's bounty goes only to a hunter, or back to the pool.
   */
  async inspect(animalId: string): Promise<{ ok: true; speciesId: string; eligible: string[]; agentId: string | null; wallet: string | null }
    | { ok: false; reason: 'not_found' | 'dead' | 'protected_species' | 'not_hunted' | 'target_taken' }> {
    const animal = this.ports.world().animal(animalId);
    if (!animal) return { ok: false, reason: 'not_found' };
    if (!animal.alive) return { ok: false, reason: 'dead' };
    if (PROTECTED_SPECIES.has(animal.speciesId)) return { ok: false, reason: 'protected_species' };
    const eligible = this.eligiblePredators(animal.speciesId);
    if (eligible.length === 0) return { ok: false, reason: 'not_hunted' };
    if ((await this.store.liveTargets()).has(animalId)) return { ok: false, reason: 'target_taken' };
    const steerer = this.ports.steererOf(animalId);
    // Its agent can win the survival half only with a proven wallet and an owner who may be paid here.
    const wallet = steerer && await this.#ownerOf(steerer) ? await this.ports.wallet(steerer) : null;
    return { ok: true, speciesId: animal.speciesId, eligible, agentId: wallet ? steerer : null, wallet };
  }

  /** Every animal agents steer now, and whether the operator could drop a bounty on it (and who would win its survival). */
  async steeredAnimals(): Promise<Array<{ animalId: string; speciesId: string; agentId: string; agentName: string | null; wallet: string | null;
    droppable: boolean; reason: string | null }>> {
    const out = [];
    for (const s of this.ports.steered()) {
      const check = await this.inspect(s.animalId);
      out.push({ animalId: s.animalId, speciesId: s.speciesId, agentId: s.agentId, agentName: s.agentName ?? null,
        wallet: check.ok ? check.wallet : await this.ports.wallet(s.agentId), droppable: check.ok, reason: check.ok ? null : check.reason });
    }
    return out;
  }

  /** Drops a bounty on the animal the operator chose, and publishes it on chain. */
  publishOn(p: { animalId: string; amountAtomic: bigint; windowWorldSeconds: number }): Promise<PublishResult> {
    return this.#serial(async () => {
      const refused = await this.#terms(p);
      if (refused) return { ok: false, reason: refused };
      const target = await this.inspect(p.animalId);
      if (!target.ok) return target;
      return this.#create({ animalId: p.animalId, speciesId: target.speciesId, agentId: target.agentId, wallet: target.wallet, eligible: target.eligible }, p, 'operator');
    });
  }

  /**
   * Checks, before anything is sent, that this server's key is the contract's evaluator (after a
   * rotation the old key is refused, and a server left with it must not try) and that the USDC
   * token counts 6 decimals. Checked once, again after a failure.
   */
  async checkIdentity(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#identity?.ok) return this.#identity;
    try {
      const id = await this.chain.identity();
      this.#identity = id.evaluator.toLowerCase() !== this.chain.evaluator.toLowerCase() ? { ok: false, reason: 'not_the_evaluator' }
        : id.usdcDecimals !== 6 ? { ok: false, reason: 'usdc_decimals' } : { ok: true };
      if (!this.#identity.ok) console.error(`[arc-bounty] refusing to publish: ${this.#identity.reason} (key ${this.chain.evaluator}, contract evaluator ${id.evaluator}, USDC decimals ${id.usdcDecimals})`);
    } catch { return { ok: false, reason: 'chain_unavailable' }; }
    return this.#identity;
  }

  /** A bounty's amount and window, against the contract's limits, the pool and the daily cap: why not, or null. */
  async #terms(p: { amountAtomic: bigint; windowWorldSeconds: number }): Promise<string | null> {
    const identity = await this.checkIdentity();
    if (!identity.ok) return identity.reason;
    if (!Number.isSafeInteger(p.windowWorldSeconds) || p.windowWorldSeconds < 600 || p.windowWorldSeconds > 14 * 86_400) return 'bad_window';
    const cap = this.ports.dailyCapAtomic;
    if (cap != null && (await this.store.publishedSince(new Date(Date.now() - 86_400_000))) + p.amountAtomic > cap) return 'daily_cap';
    const limits = await this.chain.limits();
    if (p.amountAtomic < limits.min || p.amountAtomic > limits.max) return 'amount_out_of_range';
    if ((await this.chain.pool()) < p.amountAtomic) return 'pool_too_small';
    return null;
  }

  async #create(pick: { animalId: string; speciesId: string; agentId: string | null; wallet: string | null; eligible: string[] },
    p: { amountAtomic: bigint; windowWorldSeconds: number }, selection: 'random' | 'operator'): Promise<PublishResult> {
    const world = this.ports.world(), animal = world.animal(pick.animalId)!;
    // The hour being played is mid-hour, fractional; world times are stored in whole seconds.
    const now = Math.floor(this.ports.played()), realMs = p.windowWorldSeconds / Math.max(1e-9, this.ports.rate()) * 1000;
    const expiresAt = new Date(Date.now() + Math.min(MAX_OPEN_MS, realMs * EXPIRY_FACTOR + 3_600_000));
    const rules = { version: 'congo-arc-bounty@1', selection, amountAtomic: p.amountAtomic.toString(), decimals: 6, windowWorldSeconds: p.windowWorldSeconds,
      speciesId: pick.speciesId, eligiblePredators: pick.eligible, predator: 'an agent-steered eligible predator kills it before the deadline (world time)',
      survived: pick.agentId ? 'alive at the deadline and still steered by the agent that held it at publication' : 'no agent steered it at publication: nobody',
      otherwise: 'void: back to the pool',
      // A random nonce: the rules' other fields can be guessed, and their hash must not tell whether the target is steered.
      nonce: randomBytes(16).toString('hex') };
    const bountyId = `0x${randomBytes(32).toString('hex')}`, salt = `0x${randomBytes(32).toString('hex')}`;
    const created = await this.store.create({ bountyId, targetAnimalId: pick.animalId, targetSpeciesId: pick.speciesId,
      targetRegion: regionOfPatch(world.grid, animal.patchId), targetAgentId: pick.agentId, targetWallet: pick.wallet,
      targetKey: keccak256(stringToHex(pick.animalId)), salt, amountAtomic: p.amountAtomic, windowWorldSeconds: p.windowWorldSeconds,
      publishedWorldTime: now, deadlineWorldTime: now + p.windowWorldSeconds, expiresAt, eligiblePredators: pick.eligible, rules,
      rulesHash: keccak256(stringToHex(canonicalJsonOf(rules))) });
    if (!created) return { ok: false, reason: 'target_taken' };
    await this.#publish((await this.store.get(bountyId))!);
    return { ok: true, bounty: (await this.store.get(bountyId))! };
  }

  async #publish(b: ArcBounty): Promise<void> {
    const call: BountyCall = { fn: 'publish', id: b.bountyId as Hex, amount: b.amountAtomic, expiresAt: BigInt(Math.floor(b.expiresAt.getTime() / 1000)),
      rulesHash: b.rulesHash as Hex, targetCommit: targetCommit(b.targetKey as Hex, b.salt as Hex) };
    const sent = await this.#send(b.bountyId, 'publish', call);
    if (sent === 'success') await this.#published(b.bountyId);
    else if (sent === 'reverted' && (await this.chain.status(b.bountyId as Hex)) === 'none') await this.store.failed(b.bountyId, 'publish reverted');
  }

  /** Signs, stores the hash, sends, and waits a little for the receipt. */
  async #send(bountyId: string, which: 'publish' | 'decide', call: BountyCall): Promise<'success' | 'reverted' | 'pending' | 'error'> {
    try {
      if (this.chain.submit) return await this.#sendExternal(bountyId, which, call);
      const prepared = await this.chain.prepare(call);
      await this.store.sending(bountyId, which, prepared.hash);
      await this.chain.broadcast(prepared.raw);
      for (let i = 0; i < 20; i++) {
        const r = await this.chain.receipt(prepared.hash);
        if (r) return r;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return 'pending';
    } catch (error) {
      const message = String((error as Error).message ?? error).split('\n')[0]!;
      if (which === 'publish' && /PoolTooSmall|AmountOutOfRange|ExpiryOutOfRange|EmptyCommit|NotEvaluator/.test(message)) await this.store.failed(bountyId, message);
      else await this.store.noteError(bountyId, message);
      console.error(`[arc-bounty] ${which} ${bountyId.slice(0, 10)} failed: ${message}`);
      return 'error';
    }
  }

  /**
   * Through an external signer (a Circle wallet): one transaction per call and attempt, under an
   * idempotency key drawn from them, so a send repeated after a crash returns the first; one still
   * in flight is waited on, never sent again; only one that failed is tried again, under a new key.
   * Once it is mined, its chain hash replaces the signer's reference, for the explorer links.
   */
  async #sendExternal(bountyId: string, which: 'publish' | 'decide', call: BountyCall): Promise<'success' | 'reverted' | 'pending'> {
    const row = await this.store.get(bountyId), prior = which === 'publish' ? row?.publishTx : row?.decideTx;
    const finish = async (ref: string, done: 'success' | 'reverted') => {
      const hash = done === 'success' ? await this.chain.hashOf?.(ref) : null;
      if (hash) await this.store.sending(bountyId, which, hash);
      return done;
    };
    if (prior?.startsWith(EXTERNAL_REF)) {
      const done = await this.chain.receipt(prior);
      if (done === null) return 'pending';
      if (done === 'success') return finish(prior, done);
    }
    const ref = await this.chain.submit!(call, idempotencyUuid(`${this.chain.contract}:${bountyId}:${which}:${call.fn}:${prior ?? ''}`));
    await this.store.sending(bountyId, which, ref);
    for (let i = 0; i < EXTERNAL_POLLS; i++) {
      const done = await this.chain.receipt(ref);
      if (done) return finish(ref, done);
      await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_MS));
    }
    return 'pending';
  }

  /** A publish confirmed on chain: live, its prey's agent told, and announced. */
  async #published(bountyId: string): Promise<void> {
    await this.store.published(bountyId);
    const b = (await this.store.get(bountyId))!;
    await this.#notifyPrey(b);
    this.#tellAgents('published', b);
    this.#announce('published', b);
  }

  /** A decision confirmed on chain (or found done there): settled, and announced. */
  async #settled(bountyId: string, onChain: 'paid' | 'voided'): Promise<void> {
    await this.store.settled(bountyId, onChain);
    const b = await this.store.get(bountyId);
    if (b) { this.#tellAgents('settled', b); this.#announce('settled', b); }
  }

  /**
   * The agents steering animals hear what the public board says: a bounty went live (its amount,
   * species and region, never which animal), and how one ended. The agent paid hears where.
   */
  #tellAgents(kind: 'published' | 'settled', b: ArcBounty): void {
    const key = `${kind}:${b.bountyId}`;
    if (this.#told.has(key)) return;
    this.#told.add(key);
    const usdc = Number(b.amountAtomic) / 1e6, species = b.targetSpeciesId.replaceAll('_', ' ');
    const send = (agentId: string, text: string) => { try { this.ports.notify(agentId, text); } catch { /* an agent that left */ } };
    if (kind === 'published') {
      const realLeft = Math.max(0, b.deadlineWorldTime - this.ports.played()) / Math.max(1e-9, this.ports.rate());
      const text = `A ${usdc} USDC bounty is live on Arc on a ${species} somewhere in region ${b.targetRegion}, for about ${duration(realLeft)} real time. `
        + 'Nobody is told which animal it is. An agent whose predator catches it is paid to its wallet. Details: GET /agents/me/arc-bounties.';
      for (const s of this.ports.steered()) if (s.agentId !== b.targetAgentId) send(s.agentId, text);
      return;
    }
    const paid = b.payeeWallet ? ` Paid on Arc to ${b.payeeWallet}${this.txUrl(b.decideTx) ? ` (${this.txUrl(b.decideTx)})` : ''}.` : '';
    if (b.outcome === 'predator' && b.winnerAgentId) send(b.winnerAgentId, `Your ${b.winnerAnimalId ?? 'predator'} caught ${b.targetAnimalId}, the target of a ${usdc} USDC bounty: it is yours.${paid}`);
    if (b.targetAgentId && b.targetAgentId !== b.winnerAgentId) {
      send(b.targetAgentId, b.outcome === 'survived' ? `Your ${b.targetAnimalId} survived its ${usdc} USDC bounty: it is yours.${paid}`
        : `The ${usdc} USDC bounty on your ${b.targetAnimalId} has ended (${b.outcome === 'predator' ? 'a hunter caught it' : 'nobody won it'}).`);
    }
  }

  /** A region's middle and width in metres: where the public may look, never which animal. */
  regionArea(region: string): { x: number; z: number; sizeM: number } | null {
    try {
      const g = this.ports.world().grid, centres = regionPatchIds(g, region).map((id) => patchCentre(g, id));
      const xs = centres.map((c) => c.x), zs = centres.map((c) => c.z);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, sizeM: Math.max(x1 - x0, z1 - z0) + g.patchM };
    } catch { return null; }
  }

  /** The region a patch lies in, as bounties name it. */
  regionOf(patchId: number): string | null {
    try { return regionOfPatch(this.ports.world().grid, patchId); } catch { return null; }
  }

  /** Whether this species may take a bounty on that one (the bounty's eligible predators). */
  canTake(b: ArcBounty, speciesId: string): boolean {
    return b.eligiblePredators.includes(speciesId);
  }

  #announce(kind: 'published' | 'settled', bounty: ArcBounty): void {
    try { this.ports.announce?.({ kind, bounty }); } catch (error) { console.error('[arc-bounty] announce failed', error); }
  }

  async #notifyPrey(b: ArcBounty): Promise<void> {
    if (b.notified || b.status !== 'active' || !b.targetAgentId) return;
    const usdc = Number(b.amountAtomic) / 1e6, realSeconds = b.windowWorldSeconds / Math.max(1e-9, this.ports.rate());
    this.ports.notify(b.targetAgentId, `Your animal (${b.targetAnimalId}) carries a ${usdc} USDC bounty on Arc. Keep it alive and in your control for `
      + `${duration(b.windowWorldSeconds)} of world time (about ${duration(realSeconds)} real time) and it is paid to your wallet ${b.targetWallet}. `
      + 'Hunters are not told which animal it is; an agent whose predator kills it takes the bounty.');
    await this.store.setNotified(b.bountyId);
  }

  /** A live hunt that killed a bounty's target: who killed it, at what world time. */
  async onHunt(hunt: { predatorId: string; preyId: string; predatorAgentId: string | null; preyAgentId?: string | null; killed: boolean }): Promise<void> {
    if (!hunt.killed) return;
    for (const b of await this.store.inStatus('active')) {
      if (b.targetAnimalId !== hunt.preyId) continue;
      // Rounded up: a kill a fraction of a second after the deadline is after it, never on it.
      await this.store.recordKill(b.bountyId, { agentId: hunt.predatorAgentId, animalId: hunt.predatorId, worldTime: Math.ceil(this.ports.played()),
        preyAgentId: hunt.preyAgentId ?? this.ports.steererOf(hunt.preyId) });
    }
    await this.adjudicate();
  }

  /** Decides every active bounty whose target died or whose deadline passed, then settles on chain. */
  adjudicate(): Promise<void> {
    return this.#serial(async () => {
      for (const b of await this.store.inStatus('active')) {
        const d = await this.#decision(b);
        if (d && await this.store.decide(b.bountyId, d)) await this.#sendDecision((await this.store.get(b.bountyId))!);
      }
    });
  }

  async #decision(b: ArcBounty): Promise<ArcDecision | null> {
    const world = this.ports.world(), animal = world.animal(b.targetAnimalId), deadline = b.deadlineWorldTime;
    const close = async (outcome: ArcDecision['outcome'], payeeWallet: string | null, winnerAgentId: string | null, winnerAnimalId: string | null, at: number,
      refused?: Refusal, winnerOwner: string | null = null) => {
      const actors = [b.targetAnimalId, ...(winnerAnimalId && winnerAnimalId !== b.targetAnimalId ? [winnerAnimalId] : [])];
      const events = await this.ports.eventsOf(actors, b.publishedWorldTime, at).catch(() => []);
      const record = { bountyId: b.bountyId, rulesHash: b.rulesHash, target: { animalId: b.targetAnimalId, speciesId: b.targetSpeciesId, key: b.targetKey, salt: b.salt },
        publishedWorldTime: b.publishedWorldTime, deadlineWorldTime: deadline, outcome, winnerAnimalId, decidedWorldTime: at,
        kill: b.killAnimalId ? { animalId: b.killAnimalId, worldTime: b.killWorldTime } : null, ...(refused ? { refused } : {}), events };
      return { outcome, payeeWallet, winnerAgentId, winnerAnimalId, winnerOwner, decidedWorldTime: at, record, recordHash: keccak256(stringToHex(canonicalJsonOf(record))) };
    };
    // A live kill: the hunter's agent wins if it steered an eligible predator, was not the prey's
    // agent, proved a wallet, and the kill came at or before the deadline.
    if (b.killAnimalId && b.killWorldTime !== null) {
      const species = world.animal(b.killAnimalId)?.speciesId;
      const wallet = b.killAgentId && b.killAgentId !== b.targetAgentId && species && b.eligiblePredators.includes(species) && b.killWorldTime <= deadline
        ? await this.ports.wallet(b.killAgentId) : null;
      if (wallet && !(await this.#colluded(b, b.killAgentId!, wallet))) {
        const money = await this.#fundedTogether(b, wallet);
        // The explorer cannot be read: decided on a later pass (or returned to the pool at expiry), never paid unread.
        if (money === 'unknown') return null;
        if (!money.linked) {
          const payable = await this.#payableOwner(b, b.killAgentId!, true);
          if ('refused' in payable) {
            console.error(`[arc-bounty] ${b.bountyId.slice(0, 10)}: hunter not paid (${payable.refused.reason}): void`);
            return close('void', null, null, null, b.killWorldTime, payable.refused);
          }
          return close('predator', wallet, b.killAgentId, b.killAnimalId, b.killWorldTime, undefined, payable.owner);
        }
        console.error(`[arc-bounty] ${b.bountyId.slice(0, 10)}: hunter linked to the prey by money (${money.how} via ${money.via}): void`);
        return close('void', null, null, null, b.killWorldTime, { reason: 'funding_linked', how: money.how, via: money.via });
      }
      return close('void', null, null, null, b.killWorldTime);
    }
    // Dead another way (a wild predator, illness, hunger): nobody won it.
    if (!animal?.alive) return close('void', null, null, null, Math.floor(Math.min(world.now(), deadline)));
    if (world.now() < deadline || this.ports.played() < deadline) return null;
    // Alive at the deadline: paid to the prey's agent if it still steers it, else back to the pool.
    // A wild animal's bounty (no agent held it at publication) has no survival payee.
    if (!b.targetAgentId || !b.targetWallet || this.ports.steererOf(b.targetAnimalId) !== b.targetAgentId) return close('void', null, null, null, deadline);
    const payable = await this.#payableOwner(b, b.targetAgentId, false);
    if ('refused' in payable) {
      console.error(`[arc-bounty] ${b.bountyId.slice(0, 10)}: prey not paid (${payable.refused.reason}): void`);
      return close('void', null, null, null, deadline, payable.refused);
    }
    return close('survived', b.targetWallet, b.targetAgentId, b.targetAnimalId, deadline, undefined, payable.owner);
  }

  /**
   * The wallet a decision may pay, worked out again from the agent's own proven wallet rather than
   * taken from the row: a row changed in the database cannot redirect a payment.
   */
  async #payeeHolds(b: ArcBounty): Promise<boolean> {
    if (b.outcome === 'void' || b.outcome === null) return true;
    const expected = b.outcome === 'predator' ? (b.winnerAgentId ? await this.ports.wallet(b.winnerAgentId) : null) : b.targetWallet;
    return !!expected && !!b.payeeWallet && expected.toLowerCase() === b.payeeWallet.toLowerCase()
      && (b.outcome !== 'survived' || b.winnerAgentId === b.targetAgentId);
  }

  async #sendDecision(b: ArcBounty): Promise<void> {
    if (!(await this.#payeeHolds(b))) {
      await this.store.noteError(b.bountyId, 'payee_mismatch: the payee is not the winning agent\'s proven wallet');
      console.error(`[arc-bounty] decide ${b.bountyId.slice(0, 10)} refused: payee_mismatch`);
      return;
    }
    const base = { id: b.bountyId as Hex, recordHash: b.recordHash as Hex, target: b.targetKey as Hex, salt: b.salt as Hex };
    const call: BountyCall = b.outcome === 'void' ? { fn: 'voidBounty', ...base }
      : { fn: 'settle', ...base, outcome: b.outcome!, payee: getAddress(b.payeeWallet!) };
    const sent = await this.#send(b.bountyId, 'decide', call);
    if (sent === 'success') await this.#settled(b.bountyId, b.outcome === 'void' ? 'voided' : 'paid');
  }

  /**
   * Finishes what a restart or a slow chain left: unconfirmed publishes and decisions are checked
   * against the contract's own view and sent again only if it shows them undone.
   */
  processPending(): Promise<void> {
    return this.#serial(async () => {
      const due = (sentAt: Date | null) => !sentAt || Date.now() - sentAt.getTime() > RESEND_AFTER_MS;
      for (const b of await this.store.inStatus('publishing')) {
        const onChain = await this.chain.status(b.bountyId as Hex);
        if (onChain !== 'none') { await this.#published(b.bountyId); continue; }
        if (b.expiresAt.getTime() <= Date.now() + 60_000) { await this.store.failed(b.bountyId, 'expired before it was published'); continue; }
        if (b.publishTx && (await this.chain.receipt(b.publishTx as Hex)) === 'reverted') { await this.store.failed(b.bountyId, 'publish reverted'); continue; }
        if (due(b.publishSentAt)) await this.#publish(b);
      }
      const expired = (b: ArcBounty) => Date.now() > b.expiresAt.getTime() + 60_000;
      const asVoid = (b: ArcBounty) => this.store.decide(b.bountyId,
        { outcome: 'void', payeeWallet: null, winnerAgentId: null, winnerAnimalId: null, decidedWorldTime: this.ports.world().now(),
          record: { bountyId: b.bountyId, expired: true }, recordHash: keccak256(stringToHex(`expired:${b.bountyId}`)) });
      for (const b of await this.store.inStatus('active')) {
        const onChain = await this.chain.status(b.bountyId as Hex);
        // Left open past its expiry (the server was down): anyone may return it; decided here as void.
        if (onChain === 'expired' && await asVoid(b)) { await this.#settled(b.bountyId, 'voided'); continue; }
        if (onChain === 'open' && expired(b) && await asVoid(b)) { await this.#expire((await this.store.get(b.bountyId))!); continue; }
        await this.#notifyPrey(b);
      }
      for (const b of await this.store.inStatus('deciding')) {
        const onChain = await this.chain.status(b.bountyId as Hex);
        if (onChain === 'paid') { await this.#settled(b.bountyId, 'paid'); continue; }
        if (onChain === 'voided' || onChain === 'expired') { await this.#settled(b.bountyId, 'voided'); continue; }
        if (onChain !== 'open') continue;
        // Past its expiry, or stranded (published under an evaluator since rotated out, which alone may decide it): return it.
        if (expired(b)) { if (due(b.decideSentAt)) await this.#expire(b); continue; }
        if (/NotEvaluator/.test(b.error ?? '')) continue;
        if (due(b.decideSentAt)) await this.#sendDecision(b);
      }
    });
  }

  /** Returns an expired bounty to the pool (anyone may; the contract pays nobody). */
  async #expire(b: ArcBounty): Promise<void> {
    const sent = await this.#send(b.bountyId, 'decide', { fn: 'expire', id: b.bountyId as Hex });
    if (sent === 'success') await this.#settled(b.bountyId, 'voided');
  }

  /** A link to an address on the explorer, if one is configured. */
  addressUrl(address: string): string | null {
    return this.ports.explorer ? `${this.ports.explorer.replace(/\/$/, '')}/address/${address}` : null;
  }

  /** A link to a transaction on the explorer, if one is configured. */
  txUrl(hash: string | null): string | null {
    return hash && this.ports.explorer ? `${this.ports.explorer.replace(/\/$/, '')}/tx/${hash}` : null;
  }
}

/** "20 minutes", "3 hours", "2 days 6 hours": a span of seconds as people say it. */
export function duration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), 'minute');
  if (seconds < 86_400) { const h = Math.round(seconds / 360) / 10; return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.floor(seconds / 86_400), h = Math.round((seconds % 86_400) / 3600);
  return h ? `${unit(d, 'day')} ${unit(h, 'hour')}` : unit(d, 'day');
}

/** The canonical JSON a rules or record hash is taken over (keys sorted at every level). */
export function canonicalJsonOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : typeof v === 'bigint' ? v.toString() : v;
  return JSON.stringify(canonical(value));
}
