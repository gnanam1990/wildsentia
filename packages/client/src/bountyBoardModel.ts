import { short, usdc } from './arcAdminModel.js';

/** The public bounty board (bounties.html): what each bounty says to someone who just arrived. */
export interface PublicBounty {
  bountyId: string; status: string; speciesId: string; region: string; amountAtomic: string; timeLeftWorldSeconds: number;
  publishTxUrl: string | null; outcome?: 'predator' | 'survived' | 'void'; targetAnimalId?: string; winnerAnimalId?: string | null;
  payeeWallet?: string | null; decideTxUrl?: string | null; watchPath?: string | null;
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
