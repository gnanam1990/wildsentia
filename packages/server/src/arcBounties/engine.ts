import { randomBytes, randomInt } from 'node:crypto';
import { canHunt, type World } from '@vana/sim';
import { regionOfPatch } from '@vana/shared';
import { getAddress, type Hex, keccak256, stringToHex } from 'viem';
import { PROTECTED_SPECIES } from '../bounties/engine.js';
import { type BountyCall, type BountyChain, targetCommit } from './chain.js';
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
const PREDATOR_WITHIN_M = 15_000;

export interface ArcBountyPorts {
  world: () => World;
  /** The hour being played, which trails the world's clock by up to an hour (a live kill may still beat the deadline). */
  played: () => number;
  /** World hours per real hour. */
  rate: () => number;
  /** The animals agents steer now. */
  steered: () => Iterable<{ agentId: string; animalId: string; speciesId: string }>;
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
  notify: (agentId: string, text: string) => void;
  /** The recorded events of these animals between two world times, for the bounty's record. */
  eventsOf: (animalIds: string[], from: number, to: number) => Promise<unknown[]>;
  explorer?: string | null;
}

export type PublishResult = { ok: true; bounty: ArcBounty } | { ok: false; reason: string };

export class ArcBountyEngine {
  #queue: Promise<unknown> = Promise.resolve();
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
      if (requireHunter) {
        let hunter = false;
        for (const h of steered) {
          if (h.agentId === s.agentId || !eligible.includes(h.speciesId)) continue;
          const p = world.animal(h.animalId)?.position;
          if (!p || Math.hypot(p.x - animal.position.x, p.z - animal.position.z) > PREDATOR_WITHIN_M) continue;
          if (await this.#related(h.agentId, s.agentId)) continue;
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

  /** Whether two agents registered from the same network (unless a testnet demo allows it). */
  async #related(a: string, b: string): Promise<boolean> {
    if (this.ports.sameNetworkOk) return false;
    const [na, nb] = await Promise.all([this.ports.network(a), this.ports.network(b)]);
    return na !== null && na === nb;
  }

  /** Puts a bounty on a prey animal picked at random, and publishes it on chain. */
  publishRandom(p: { amountAtomic: bigint; windowWorldSeconds: number; requireHunter?: boolean }): Promise<PublishResult> {
    return this.#serial(async () => {
      if (!Number.isSafeInteger(p.windowWorldSeconds) || p.windowWorldSeconds < 600 || p.windowWorldSeconds > 14 * 86_400) return { ok: false, reason: 'bad_window' };
      const limits = await this.chain.limits();
      if (p.amountAtomic < limits.min || p.amountAtomic > limits.max) return { ok: false, reason: 'amount_out_of_range' };
      if ((await this.chain.pool()) < p.amountAtomic) return { ok: false, reason: 'pool_too_small' };
      const candidates = await this.candidates(p.requireHunter ?? true);
      if (candidates.length === 0) return { ok: false, reason: 'no_candidate' };
      const pick = candidates[randomInt(candidates.length)]!, world = this.ports.world(), animal = world.animal(pick.animalId)!;
      const now = this.ports.played(), realMs = p.windowWorldSeconds / Math.max(1e-9, this.ports.rate()) * 1000;
      const expiresAt = new Date(Date.now() + Math.min(MAX_OPEN_MS, realMs * EXPIRY_FACTOR + 3_600_000));
      const rules = { version: 'congo-arc-bounty@1', amountAtomic: p.amountAtomic.toString(), decimals: 6, windowWorldSeconds: p.windowWorldSeconds,
        speciesId: pick.speciesId, eligiblePredators: pick.eligible, predator: 'an agent-steered eligible predator kills it before the deadline (world time)',
        survived: 'alive at the deadline and still steered by the agent that held it at publication', otherwise: 'void: back to the pool' };
      const bountyId = `0x${randomBytes(32).toString('hex')}`, salt = `0x${randomBytes(32).toString('hex')}`;
      const targetKey = keccak256(stringToHex(pick.animalId));
      const created = await this.store.create({ bountyId, targetAnimalId: pick.animalId, targetSpeciesId: pick.speciesId,
        targetRegion: regionOfPatch(world.grid, animal.patchId), targetAgentId: pick.agentId, targetWallet: pick.wallet, targetKey, salt,
        amountAtomic: p.amountAtomic, windowWorldSeconds: p.windowWorldSeconds, publishedWorldTime: now, deadlineWorldTime: now + p.windowWorldSeconds,
        expiresAt, eligiblePredators: pick.eligible, rules, rulesHash: keccak256(stringToHex(canonicalJsonOf(rules))) });
      if (!created) return { ok: false, reason: 'target_taken' };
      const b = (await this.store.get(bountyId))!;
      await this.#publish(b);
      return { ok: true, bounty: (await this.store.get(bountyId))! };
    });
  }

  async #publish(b: ArcBounty): Promise<void> {
    const call: BountyCall = { fn: 'publish', id: b.bountyId as Hex, amount: b.amountAtomic, expiresAt: BigInt(Math.floor(b.expiresAt.getTime() / 1000)),
      rulesHash: b.rulesHash as Hex, targetCommit: targetCommit(b.targetKey as Hex, b.salt as Hex) };
    const sent = await this.#send(b.bountyId, 'publish', call);
    if (sent === 'success') { await this.store.published(b.bountyId); await this.#notifyPrey((await this.store.get(b.bountyId))!); }
    else if (sent === 'reverted' && (await this.chain.status(b.bountyId as Hex)) === 'none') await this.store.failed(b.bountyId, 'publish reverted');
  }

  /** Signs, stores the hash, sends, and waits a little for the receipt. */
  async #send(bountyId: string, which: 'publish' | 'decide', call: BountyCall): Promise<'success' | 'reverted' | 'pending' | 'error'> {
    try {
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

  async #notifyPrey(b: ArcBounty): Promise<void> {
    if (b.notified || b.status !== 'active') return;
    const usdc = Number(b.amountAtomic) / 1e6, worldHours = b.windowWorldSeconds / 3600, realHours = worldHours / Math.max(1e-9, this.ports.rate());
    this.ports.notify(b.targetAgentId, `Your animal (${b.targetAnimalId}) carries a ${usdc} USDC bounty on Arc. Keep it alive and in your control for `
      + `${worldHours.toFixed(0)} world hours (about ${realHours.toFixed(1)} real hours) and it is paid to your wallet ${b.targetWallet}. `
      + 'Hunters are not told which animal it is; an agent whose predator kills it takes the bounty.');
    await this.store.setNotified(b.bountyId);
  }

  /** A live hunt that killed a bounty's target: who killed it, at what world time. */
  async onHunt(hunt: { predatorId: string; preyId: string; predatorAgentId: string | null; killed: boolean }): Promise<void> {
    if (!hunt.killed) return;
    for (const b of await this.store.inStatus('active')) {
      if (b.targetAnimalId !== hunt.preyId) continue;
      await this.store.recordKill(b.bountyId, { agentId: hunt.predatorAgentId, animalId: hunt.predatorId, worldTime: this.ports.played() });
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
    const close = async (outcome: ArcDecision['outcome'], payeeWallet: string | null, winnerAgentId: string | null, winnerAnimalId: string | null, at: number) => {
      const actors = [b.targetAnimalId, ...(winnerAnimalId && winnerAnimalId !== b.targetAnimalId ? [winnerAnimalId] : [])];
      const events = await this.ports.eventsOf(actors, b.publishedWorldTime, at).catch(() => []);
      const record = { bountyId: b.bountyId, rulesHash: b.rulesHash, target: { animalId: b.targetAnimalId, speciesId: b.targetSpeciesId, key: b.targetKey, salt: b.salt },
        publishedWorldTime: b.publishedWorldTime, deadlineWorldTime: deadline, outcome, winnerAnimalId, decidedWorldTime: at,
        kill: b.killAnimalId ? { animalId: b.killAnimalId, worldTime: b.killWorldTime } : null, events };
      return { outcome, payeeWallet, winnerAgentId, winnerAnimalId, decidedWorldTime: at, record, recordHash: keccak256(stringToHex(canonicalJsonOf(record))) };
    };
    // A live kill: the hunter's agent wins if it steered an eligible predator, was not the prey's
    // agent, proved a wallet, and the kill came at or before the deadline.
    if (b.killAnimalId && b.killWorldTime !== null) {
      const species = world.animal(b.killAnimalId)?.speciesId;
      const wallet = b.killAgentId && b.killAgentId !== b.targetAgentId && species && b.eligiblePredators.includes(species) && b.killWorldTime <= deadline
        ? await this.ports.wallet(b.killAgentId) : null;
      if (wallet && wallet.toLowerCase() !== b.targetWallet && !(await this.#related(b.killAgentId!, b.targetAgentId)))
        return close('predator', wallet, b.killAgentId, b.killAnimalId, b.killWorldTime);
      return close('void', null, null, null, b.killWorldTime);
    }
    // Dead another way (a wild predator, illness, hunger): nobody won it.
    if (!animal?.alive) return close('void', null, null, null, Math.min(world.now(), deadline));
    if (world.now() < deadline || this.ports.played() < deadline) return null;
    // Alive at the deadline: paid to the prey's agent if it still steers it, else back to the pool.
    return this.ports.steererOf(b.targetAnimalId) === b.targetAgentId
      ? close('survived', b.targetWallet, b.targetAgentId, b.targetAnimalId, deadline)
      : close('void', null, null, null, deadline);
  }

  async #sendDecision(b: ArcBounty): Promise<void> {
    const base = { id: b.bountyId as Hex, recordHash: b.recordHash as Hex, target: b.targetKey as Hex, salt: b.salt as Hex };
    const call: BountyCall = b.outcome === 'void' ? { fn: 'voidBounty', ...base }
      : { fn: 'settle', ...base, outcome: b.outcome!, payee: getAddress(b.payeeWallet!) };
    const sent = await this.#send(b.bountyId, 'decide', call);
    if (sent === 'success') await this.store.settled(b.bountyId, b.outcome === 'void' ? 'voided' : 'paid');
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
        if (onChain !== 'none') { await this.store.published(b.bountyId); await this.#notifyPrey((await this.store.get(b.bountyId))!); continue; }
        if (b.expiresAt.getTime() <= Date.now() + 60_000) { await this.store.failed(b.bountyId, 'expired before it was published'); continue; }
        if (b.publishTx && (await this.chain.receipt(b.publishTx as Hex)) === 'reverted') { await this.store.failed(b.bountyId, 'publish reverted'); continue; }
        if (due(b.publishSentAt)) await this.#publish(b);
      }
      for (const b of await this.store.inStatus('active')) {
        // Left open past its expiry (the server was down): anyone may return it; decided here as void.
        if ((await this.chain.status(b.bountyId as Hex)) === 'expired' && await this.store.decide(b.bountyId,
          { outcome: 'void', payeeWallet: null, winnerAgentId: null, winnerAnimalId: null, decidedWorldTime: this.ports.world().now(),
            record: { bountyId: b.bountyId, expired: true }, recordHash: keccak256(stringToHex(`expired:${b.bountyId}`)) })) {
          await this.store.settled(b.bountyId, 'voided');
        } else await this.#notifyPrey(b);
      }
      for (const b of await this.store.inStatus('deciding')) {
        const onChain = await this.chain.status(b.bountyId as Hex);
        if (onChain === 'paid') { await this.store.settled(b.bountyId, 'paid'); continue; }
        if (onChain === 'voided' || onChain === 'expired') { await this.store.settled(b.bountyId, 'voided'); continue; }
        if (onChain === 'open' && due(b.decideSentAt)) await this.#sendDecision(b);
      }
    });
  }

  /** A link to a transaction on the explorer, if one is configured. */
  txUrl(hash: string | null): string | null {
    return hash && this.ports.explorer ? `${this.ports.explorer.replace(/\/$/, '')}/tx/${hash}` : null;
  }
}

/** The canonical JSON a rules or record hash is taken over (keys sorted at every level). */
export function canonicalJsonOf(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : typeof v === 'bigint' ? v.toString() : v;
  return JSON.stringify(canonical(value));
}
