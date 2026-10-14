/**
 * A local Congo demo for browser journeys (plan 1E): the Congo world with owned animals, bounties
 * and agents, and test sign-in for a few test people. LOCAL ONLY: it refuses to start unless
 * VANA_DEV_DEMO=1, it listens on 127.0.0.1, and it is never part of the production server.
 *
 *   DATABASE_URL=postgres://…/local VANA_DEV_DEMO=1 VANA_BOUNTY_ADMIN_TOKEN=<a local test value> npx tsx tools/dev/congoDemo.ts
 *
 * Test people sign in at /dev/signin?person=N (a cookie this server alone honours). Every amount
 * is SIMULATED; the demo tops the SIMULATED reward pool up once so bounties can be published.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../packages/server/src/db/pool.js';
import { migrate } from '../../packages/server/src/db/migrate.js';
import { SimHost } from '../../packages/server/src/simHost.js';
import { buildApi } from '../../packages/server/src/api.js';
import { Gateway } from '../../packages/server/src/gateway.js';
import { liveRuntime } from '../../packages/server/src/live/runtime.js';
import { CONGO_POPULATION } from '../../packages/sim/src/forest.js';
import { ExperienceStore } from '../../packages/server/src/experiences/store.js';
import { ExperienceService } from '../../packages/server/src/experiences/service.js';
import { experienceConfig } from '../../packages/server/src/experiences/config.js';

const PORT = Number(process.env.PORT ?? 8080), HOST = '127.0.0.1', ORIGIN = process.env.VANA_DEMO_ORIGIN ?? 'http://localhost:5173';
/** Test people of this demo only: test wallets, never anyone's real one. */
const PEOPLE = [{ n: 1, name: 'Amara' }, { n: 2, name: 'Kofi' }, { n: 3, name: 'Nia' }] as const;

export function assertLocalDemo(env: NodeJS.ProcessEnv): void {
  if (env.VANA_DEV_DEMO !== '1') throw new Error('congoDemo is a local demo: set VANA_DEV_DEMO=1 to run it');
  if (env.NODE_ENV === 'production') throw new Error('congoDemo never runs in production');
  if (!env.DATABASE_URL || !/@(127\.0\.0\.1|localhost)[:/]/.test(env.DATABASE_URL)) throw new Error('congoDemo needs a local DATABASE_URL');
}

async function main(): Promise<void> {
  assertLocalDemo(process.env);
  const pool = createPool(process.env.DATABASE_URL!);
  await migrate(pool);
  const host = new SimHost({ pool, seed: Number(process.env.WORLD_SEED ?? 7), speciesDir: fileURLToPath(new URL('../../config/species-congo', import.meta.url)),
    terrainProfile: 'congo_v1', initialAgents: CONGO_POPULATION, minPopulation: {}, landscape: null,
    worldHoursPerRealHour: Number(process.env.WORLD_HOURS_PER_REAL_HOUR ?? 12) });
  const boot = await host.boot();
  console.log(boot.restoredFrom === null ? 'demo: booted a fresh Congo world' : `demo: restored the Congo world at ${boot.restoredFrom}`);

  // Test people: a live identity with a test wallet, and an account, each.
  for (const p of PEOPLE) {
    const agentId = `ag_${p.n.toString(16).padStart(16, 'd')}`, wallet = `0x${'d'.repeat(39)}${p.n}`;
    const accountId = `00000000-0000-4000-8000-${p.n.toString().padStart(12, '0')}`;
    await pool.query(`insert into live_agents (id, kind, public_key, name, name_key, network_hash, wallet, wallet_proven) values ($1,'human',null,$2,$3,'demo',$4,true)
      on conflict (id) do nothing`, [agentId, p.name, `demo-${p.name.toLowerCase()}`, wallet]);
    await pool.query(`insert into accounts (id, x_user_id, x_handle, x_name, x_created_at, agent_id) values ($1,$2,$3,$3,now() - interval '1 year',$4)
      on conflict (id) do nothing`, [accountId, String(900_000 + p.n), `demo_${p.name.toLowerCase()}`, agentId]);
  }
  if ((await pool.query("select 1 from sim_ledger where ref='demo top-up'")).rows.length === 0)
    await pool.query("insert into sim_ledger (category, amount_atomic, decimals, ref) values ('reward_pool', 1000000000, 6, 'demo top-up')");

  const live = liveRuntime(host, pool, undefined, { ...process.env, VANA_LIVE_AGENTS: '1', VANA_LIVE_SECRET: createHash('sha256').update('congo-demo').digest('hex') });
  if (!live) throw new Error('live agents did not start');
  const cookie = (header: string | undefined) => header?.match(/(?:^|;\s*)demo_person=(\d)/)?.[1];
  const humans = { origin: ORIGIN, account: async (req: { headers: { cookie?: string } }) => {
    const n = Number(cookie(req.headers.cookie));
    return PEOPLE.some((p) => p.n === n) ? { agentId: `ag_${n.toString(16).padStart(16, 'd')}`, xAccountDays: 365 } : null;
  } };
  // The experiences (league, lab), played among the Congo forest's own animals.
  const experiences = new ExperienceService(new ExperienceStore(pool), host, experienceConfig(process.env),
    fileURLToPath(new URL('../../config/species-congo', import.meta.url)));
  await experiences.start();
  const api = buildApi({ host, pool, experiences, live: { ...live.routes, spot: live.spot, species: () => [...host.world.species.values()], humans } });
  // The demo's own sign-in: test people only, a cookie only this demo reads.
  api.get('/dev/people', async () => ({ people: PEOPLE }));
  api.get<{ Querystring: { person?: string } }>('/dev/signin', async (req, reply) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'same_origin_required' });
    const n = Number(req.query.person);
    if (!PEOPLE.some((p) => p.n === n)) return reply.code(404).send({ error: 'no_such_person' });
    return reply.header('set-cookie', `demo_person=${n}; Path=/; HttpOnly; SameSite=Lax`).redirect(`${ORIGIN}/congo.html`);
  });
  // A demo shortcut, never in production: set an unsteered animal down 60 m from another, so a
  // browser journey need not wait for an agent to range across 48 km of forest.
  api.post<{ Querystring: { animal?: string; near?: string } }>('/dev/stage', async (req, reply) => {
    // Only from this machine's own pages or tools, never another site's page in the browser.
    if (req.headers.origin && req.headers.origin !== ORIGIN) return reply.code(403).send({ error: 'origin_mismatch' });
    const placed = await host.exclusive(async () => {
      const id = String(req.query.animal ?? ''), near = String(req.query.near ?? '');
      const target = live.routes.live.positionOf(near) ?? host.world.animal(near)?.position;
      if (!target) return false;
      const spot = { x: target.x + 60, z: target.z, heading: -Math.PI / 2 }, avatar = live.routes.live.avatars.byAnimal(id);
      if (!avatar) return host.world.placeWild(id, spot);
      // A steered animal is where its avatar is.
      if (!host.world.placeControlled(id, spot)) return false;
      avatar.x = spot.x; avatar.z = spot.z; avatar.heading = spot.heading; avatar.path = []; avatar.moving = false;
      return true;
    });
    return placed ? { staged: true } : reply.code(409).send({ error: 'cannot_stage' });
  });
  // What the site's pages ask of an account (the demo's test people only).
  api.get('/accounts/me', async (req, reply) => {
    const n = Number(cookie(req.headers.cookie)), p = PEOPLE.find((x) => x.n === n);
    if (!p) return reply.code(401).send({ error: 'signed_out' });
    return { account: { handle: `demo_${p.name.toLowerCase()}`, name: p.name, xAccountDays: 365, agentId: `ag_${n.toString(16).padStart(16, 'd')}`,
      playerName: p.name, wallet: `0x${'d'.repeat(39)}${n}`, canCreate: false, canPlay: true, createsLeftToday: 0, needs: [] } };
  });
  api.post('/accounts/logout', async (_req, reply) => reply.header('set-cookie', 'demo_person=; Path=/; Max-Age=0').send({ ok: true }));
  await api.ready();
  const server = createServer((req, res) => { api.server.emit('request', req, res); });
  const gateway = new Gateway(host, { maxConnections: 50, maxPerNetwork: 20, trustedProxyHops: 0 });
  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  gateway.attach(server);
  host.start();
  setInterval(() => gateway.broadcast(), 1000);
  await live.start({ live: (state, at) => gateway.broadcastLive(state as never, at), roster: (state) => gateway.broadcastRoster(state as never) });
  console.log(`demo: listening on http://${HOST}:${PORT} (Congo, SIMULATED money, test people only)`);
  const stop = async () => { await live.stop(); await host.stop(); server.close(); await pool.end(); process.exit(0); };
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((e) => { console.error(e); process.exit(1); });
