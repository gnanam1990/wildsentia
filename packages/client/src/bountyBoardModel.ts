import { short, usdc } from './arcAdminModel.js';

/** The public bounty board (bounties.html): what each bounty says to someone who just arrived. */
export interface PublicBounty {
  bountyId: string; status: string; speciesId: string; region: string; amountAtomic: string; timeLeftWorldSeconds: number;
  publishTxUrl: string | null; outcome?: 'predator' | 'survived' | 'void'; targetAnimalId?: string; winnerAnimalId?: string | null;
  payeeWallet?: string | null; decideTxUrl?: string | null; watchPath?: string | null;
  /** The region's middle and width in metres: where to look, never which animal. */
  area?: { x: number; z: number; sizeM: number } | null;
}

/** Whether a bounty is live (shown as wanted) or decided (shown as a result); one on its way to the chain is neither. */
export const isLive = (b: PublicBounty) => !b.outcome && b.status === 'active';
export const isResult = (b: PublicBounty) => !!b.outcome && b.status !== 'deciding';

/** What the forest tells a viewer it has not told before: bounties gone live, then bounties decided. */
export interface BountyNews { key: string; kind: 'live' | 'result'; bounty: PublicBounty }
export function bountyNews(list: readonly PublicBounty[], told: ReadonlySet<string>): BountyNews[] {
  const news: BountyNews[] = [];
  for (const b of list) {
    const kind = isLive(b) ? 'live' : isResult(b) ? 'result' : null;
    if (kind && !told.has(`${kind}:${b.bountyId}`)) news.push({ key: `${kind}:${b.bountyId}`, kind, bounty: b });
  }
  return news.sort((x, y) => Number(x.kind === 'result') - Number(y.kind === 'result'));
}

/** The keys of news already told, kept in the browser (newest last, at most `limit`); storage may be blocked. */
export class ToldBounties {
  readonly #keys: string[];
  /** Whether nothing was ever told in this browser: its first look starts from what is live, not from old results. */
  readonly first: boolean;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null, private readonly limit = 200, private readonly name = 'wildsentia.bountiesTold') {
    let keys: unknown = null;
    try { keys = JSON.parse(storage?.getItem(name) ?? 'null'); } catch { keys = null; }
    this.first = !Array.isArray(keys);
    this.#keys = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string').slice(-limit) : [];
  }
  get set(): ReadonlySet<string> { return new Set(this.#keys); }
  add(...keys: string[]): void {
    for (const k of keys) if (!this.#keys.includes(k)) this.#keys.push(k);
    this.#keys.splice(0, Math.max(0, this.#keys.length - this.limit));
    try { this.storage?.setItem(this.name, JSON.stringify(this.#keys)); } catch { /* told again next visit */ }
  }
}

/** The forest's chip: how many bounties are live and what they hold together. */
export function liveSummary(list: readonly PublicBounty[]): string | null {
  const live = list.filter(isLive);
  if (!live.length) return null;
  const total = live.reduce((sum, b) => sum + BigInt(b.amountAtomic), 0n);
  return `${live.length} ${live.length === 1 ? 'bounty' : 'bounties'} live · ${usdc(total)}`;
}

const readable = (id: string) => id.replaceAll('_', ' ');
const animalSpecies = (id: string) => readable(id.replace(/_[0-9a-z]+$/, ''));

/** "about 4 h 10 min" or "about 25 min" of real time left, at the world's speed; "ending" when it is due. */
export function realTimeLeft(worldSeconds: number, rate: number): string {
  if (worldSeconds <= 0) return 'ending';
  const minutes = Math.max(1, Math.round(worldSeconds / Math.max(1e-9, rate) / 60));
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `about ${h} h${m ? ` ${m} min` : ''}`;
}

/** A live bounty's headline: amount and species, never which animal. */
export function wantedLine(b: PublicBounty): string {
  return `${usdc(b.amountAtomic)} on a ${readable(b.speciesId)}`;
}

/** A decided bounty's headline and what happened, in a line each. */
export function resultLines(b: PublicBounty): { headline: string; detail: string } {
  const amount = usdc(b.amountAtomic), target = b.targetAnimalId ?? readable(b.speciesId);
  if (b.outcome === 'predator') return { headline: `Hunter won ${amount}`,
    detail: `${b.winnerAnimalId ? `An agent's ${animalSpecies(b.winnerAnimalId)}` : 'A hunter'} caught ${target}; paid to ${short(b.payeeWallet)}.` };
  if (b.outcome === 'survived') return { headline: `Prey survived: ${amount}`, detail: `${target} lived to the deadline; its agent was paid at ${short(b.payeeWallet)}.` };
  return { headline: 'Got away', detail: `Nobody caught ${target}; the ${amount} went back to the pool.` };
}

/** The link a bounty is shared by: the server's page that carries its card, then opens the board. */
export function shareUrl(origin: string, bountyId: string): string {
  return `${origin.replace(/\/$/, '')}/api/share/bounty/${bountyId}`;
}
