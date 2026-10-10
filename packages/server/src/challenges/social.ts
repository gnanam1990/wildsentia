import { randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { formatUsdc } from './drafts.js';
import { describeTerms, type ChallengeTerms, type SpeciesCatalog } from './terms.js';

/**
 * X post drafts about challenges (plan 3c). Each is written from the challenge's own facts (its
 * goal and rules as the server describes them, the prize, the deadline, the winner's player name),
 * never from the creator's briefing. Nothing is posted without the owner's approval and a publish.
 */
export type PostKind = 'created' | 'won' | 'refunded';
export interface PostFacts { id: number; description: string; prizeUsdc: string; deadline: Date; winnerName?: string | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The post, at most 280 characters: with the goal's rules if they fit, otherwise the goal alone. */
export function challengePostText(kind: PostKind, f: PostFacts, siteUrl: string | null): string | null {
  const link = siteUrl ? ` ${siteUrl}/challenges.html?id=${f.id}` : '';
  const write = (desc: string) => {
    switch (kind) {
      case 'created': return `New Wildsentia challenge on Arc: ${desc}. Prize ${f.prizeUsdc} USDC to the first player (person or AI agent) to do it by ${day(f.deadline)}.${link}`;
      case 'won': return `Wildsentia challenge ${f.id} was won by ${f.winnerName ?? 'a player'}: ${desc}. ${f.prizeUsdc} USDC paid on Arc.${link}`;
      case 'refunded': return `Nobody met Wildsentia challenge ${f.id} in time (${desc}). The ${f.prizeUsdc} USDC went back to its creator on Arc.${link}`;
    }
  };
  for (const desc of [lower(f.description), lower(f.description.split(';')[0]!)]) {
    const text = write(desc);
    if (text.length <= 280) return text;
  }
  return null;
}

export interface SocialDraft {
  id: string; challengeId: number; kind: PostKind; body: string; status: string; xPostId: string | null; note: string;
  createdAt: Date; reviewedAt: Date | null; publishedAt: Date | null;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const draftOf = (r: any): SocialDraft => ({ id: r.id, challengeId: Number(r.challenge_id), kind: r.kind, body: r.body, status: r.status,
  xPostId: r.x_post_id, note: r.note, createdAt: r.created_at, reviewedAt: r.reviewed_at, publishedAt: r.published_at });
/* eslint-enable @typescript-eslint/no-explicit-any */

export class ChallengeSocialStore {
  constructor(private readonly pool: Pool, private readonly catalog: SpeciesCatalog, private readonly siteUrl: string | null) {}

  /** The post a kind should say about a challenge now, from its facts; null if it has none to say. */
  async textFor(challengeId: number, kind: PostKind): Promise<string | null> {
    const { rows } = await this.pool.query(`select c.id, c.terms, c.prize_atomic, c.deadline, c.status, l.name as winner_name
      from challenges c left join challenge_attempts a on a.id = c.winner_attempt left join live_agents l on l.id = a.agent_id
      where c.id = $1`, [challengeId]);
    const c = rows[0];
    if (!c?.terms || c.status === 'unrecognised') return null;
    if ((kind === 'won' && c.status !== 'paid') || (kind === 'refunded' && c.status !== 'refunded')) return null;
    const terms = { rules: [], briefing: '', ...c.terms } as ChallengeTerms;
    return challengePostText(kind, { id: Number(c.id), description: describeTerms(terms, this.catalog), prizeUsdc: formatUsdc(String(c.prize_atomic)),
      deadline: c.deadline, winnerName: c.winner_name ?? null }, this.siteUrl);
  }

  /** Drafts what is due: a created post for every recognised challenge, won once paid, refunded once refunded. */
  async sweep(): Promise<number> {
    const { rows } = await this.pool.query(`select c.id, k.kind from challenges c
      cross join (values ('created'), ('won'), ('refunded')) as k(kind)
      where c.status <> 'unrecognised' and c.terms is not null
        and (k.kind = 'created' or (k.kind = 'won' and c.status = 'paid') or (k.kind = 'refunded' and c.status = 'refunded'))
        and not exists (select 1 from challenge_social_drafts d where d.challenge_id = c.id and d.kind = k.kind)
      order by c.id limit 200`);
    let made = 0;
    for (const r of rows as Array<{ id: string; kind: PostKind }>) {
      const body = await this.textFor(Number(r.id), r.kind);
      if (!body) continue;
      const inserted = await this.pool.query(`insert into challenge_social_drafts (id, challenge_id, kind, body) values ($1, $2, $3, $4)
        on conflict (challenge_id, kind) do nothing`, [randomUUID(), r.id, r.kind, body]);
      made += inserted.rowCount ?? 0;
    }
    return made;
  }

  async list(limit = 200): Promise<SocialDraft[]> {
    const { rows } = await this.pool.query('select * from challenge_social_drafts order by created_at desc, challenge_id desc limit $1', [limit]);
    return rows.map(draftOf);
  }

  async get(id: string): Promise<SocialDraft | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const { rows } = await this.pool.query('select * from challenge_social_drafts where id = $1', [id]);
    return rows[0] ? draftOf(rows[0]) : null;
  }

  /** True while the draft still says what the challenge's facts say. */
  async stillTrue(d: SocialDraft): Promise<boolean> {
    return d.body === await this.textFor(d.challengeId, d.kind);
  }
}
