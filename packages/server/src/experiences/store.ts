import { randomUUID } from "node:crypto";
import type { ExperienceJob, LeagueRequest, LabRequest } from "@vana/shared";
import type { Pool } from "../db/pool.js";
type Row = {
  id: string;
  kind: ExperienceJob["kind"];
  status: ExperienceJob["status"];
  request: ExperienceJob["request"];
  progress: ExperienceJob["progress"];
  result: ExperienceJob["result"];
  error_code: string | null;
  created_at: Date;
};
const job = (r: Row): ExperienceJob => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  request: r.request,
  progress: r.progress,
  result: r.result,
  error: r.error_code,
  createdAt: r.created_at.toISOString(),
});
export class ExperienceStore {
  constructor(readonly pool: Pool) {}
  async recover(): Promise<void> {
    await this.pool.query(
      "update experience_jobs set status='interrupted',error_code='server_restarted',updated_at=now() where status='running'",
    );
    await this.pool.query(
      "delete from experience_jobs where created_at < now()-interval '30 days'",
    );
    await this.pool.query(
      "delete from experience_budgets where day < current_date-7",
    );
    await this.pool.query(
      "delete from experience_follows where created_at < now()-interval '365 days'",
    );
  }
  async create(
    owner: string,
    kind: ExperienceJob["kind"],
    request: LeagueRequest | LabRequest,
  ): Promise<ExperienceJob | null> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query(
        "select pg_advisory_xact_lock(hashtextextended('forest-experience-jobs',0))",
      );
      const {
        rows: [count],
      } = await c.query<{ active: number; recent: number; daily: number }>(
        `select
        count(*) filter(where status='running')::int as active,
        count(*) filter(where owner_hash=$1 and created_at > now()-interval '1 hour')::int as recent,
        count(*) filter(where created_at > now()-interval '24 hours')::int as daily from experience_jobs`,
        [owner],
      );
      if (
        !count ||
        count.active >= 2 ||
        count.recent >= 4 ||
        count.daily >= 64
      ) {
        await c.query("rollback");
        return null;
      }
      const {
        rows: [r],
      } = await c.query<Row>(
        `insert into experience_jobs(id,owner_hash,kind,status,request)
        values($1,$2,$3,'running',$4::jsonb) returning *`,
        [randomUUID(), owner, kind, JSON.stringify(request)],
      );
      await c.query("commit");
      return job(r!);
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }
  async byId(id: string, owner: string): Promise<ExperienceJob | null> {
    const {
      rows: [r],
    } = await this.pool.query<Row>(
      "select * from experience_jobs where id=$1 and owner_hash=$2",
      [id, owner],
    );
    return r ? job(r) : null;
  }
  async recent(owner: string): Promise<ExperienceJob[]> {
    const { rows } = await this.pool.query<Row>(
      `select id,kind,status,request,'{"percent":0}'::jsonb as progress,null::jsonb as result,error_code,created_at
      from experience_jobs where owner_hash=$1 order by created_at desc limit 8`,
      [owner],
    );
    return rows.map(job);
  }
  async progress(id: string, p: ExperienceJob["progress"]): Promise<void> {
    await this.pool.query(
      "update experience_jobs set progress=$2::jsonb,updated_at=now() where id=$1 and status='running'",
      [id, JSON.stringify(p)],
    );
  }
  async finish(
    id: string,
    status: Exclude<ExperienceJob["status"], "running">,
    result: ExperienceJob["result"],
    error: string | null = null,
  ): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const {
        rows: [r],
      } = await c.query<Row>(
        "update experience_jobs set status=$2,result=$3::jsonb,error_code=$4,updated_at=now() where id=$1 and status='running' returning *",
        [id, status, JSON.stringify(result), error],
      );
      if (
        r?.kind === "league" &&
        status === "completed" &&
        result &&
        "standings" in result
      ) {
        const q = r.request as LeagueRequest,
          season = r.created_at.toISOString().slice(0, 7);
        for (const s of result.standings)
          await c.query(
            `insert into experience_scores(season,mission,species,player_id,player_label,matches,wins,points)
          values($1,$2,$3,$4,$5,1,$6,$7) on conflict(season,mission,species,player_id) do update set
          matches=experience_scores.matches+1,wins=experience_scores.wins+excluded.wins,points=experience_scores.points+excluded.points`,
            [
              season,
              q.mission,
              q.species,
              s.player.id,
              s.player.id === "human" ? "People" : s.player.label,
              Number(result.winners.includes(s.player.id)),
              s.status === "provider_error" ? 0 : s.frame.points,
            ],
          );
      }
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }
  async reserve(kind: string, amount: number, limit: number): Promise<boolean> {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < amount
    )
      return false;
    const { rows } = await this.pool.query(
      `insert into experience_budgets(day,kind,used) values((now() at time zone 'UTC')::date,$1,$2)
      on conflict(day,kind) do update set used=experience_budgets.used+excluded.used
      where experience_budgets.used+excluded.used <= $3 returning used`,
      [kind, amount, limit],
    );
    return rows.length === 1;
  }
  async follow(
    owner: string,
    world: string,
    animal: string,
    nickname: string,
    seen: number,
  ): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `forest-follows:${owner}`,
      ]);
      const {
        rows: [n],
      } = await c.query<{ n: number }>(
        "select count(*)::int as n from experience_follows where owner_hash=$1",
        [owner],
      );
      const { rows: existing } = await c.query(
        "select 1 from experience_follows where owner_hash=$1 and world_id=$2 and animal_id=$3",
        [owner, world, animal],
      );
      if ((n?.n ?? 0) >= 20 && !existing.length) {
        await c.query("rollback");
        return false;
      }
      await c.query(
        `insert into experience_follows(owner_hash,world_id,animal_id,nickname,seen_sequence) values($1,$2,$3,$4,$5)
        on conflict(owner_hash,world_id,animal_id) do update set nickname=excluded.nickname`,
        [owner, world, animal, nickname, seen],
      );
      await c.query("commit");
      return true;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }
  async follows(owner: string, world: string) {
    const { rows } = await this.pool.query<{
      animal_id: string;
      nickname: string;
      seen_sequence: string;
    }>(
      "select animal_id,nickname,seen_sequence from experience_follows where owner_hash=$1 and world_id=$2 order by created_at limit 20",
      [owner, world],
    );
    return rows;
  }
  async unfollow(owner: string, world: string, animal: string): Promise<void> {
    await this.pool.query(
      "delete from experience_follows where owner_hash=$1 and world_id=$2 and animal_id=$3",
      [owner, world, animal],
    );
  }
  async seen(owner: string, world: string, sequence: number): Promise<void> {
    await this.pool.query(
      "update experience_follows set seen_sequence=greatest(seen_sequence,$3) where owner_hash=$1 and world_id=$2",
      [owner, world, sequence],
    );
  }
  async leaderboard() {
    const { rows } = await this.pool.query<{
      id: string;
      request: LeagueRequest;
      result: NonNullable<ExperienceJob["result"]>;
      created_at: Date;
    }>(
      `select id,request,jsonb_build_object('winners',result->'winners','standings',
        (select jsonb_agg(s-'frames') from jsonb_array_elements(result->'standings') s)) as result,created_at
        from experience_jobs where kind='league' and status='completed' order by created_at desc limit 20`,
    );
    return rows.map((r) => ({
      id: r.id,
      request: r.request,
      result: r.result,
      createdAt: r.created_at.toISOString(),
    }));
  }
  async season() {
    const season = new Date().toISOString().slice(0, 7);
    const { rows } = await this.pool.query<{
      player_label: string;
      mission: string;
      species: string;
      matches: number;
      wins: number;
      points: string;
    }>(
      "select player_label,mission,species,matches,wins,points from experience_scores where season=$1 order by wins desc,points desc,player_label limit 20",
      [season],
    );
    return { season, rows };
  }
}
