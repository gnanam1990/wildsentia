import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createWorld } from '@vana/sim';
import { recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';
import { AgentStore } from '../src/live/liveStore.js';
import { EXAMPLE_NAME, installLiveAgents } from '../src/live/routes.js';
import { testDatabaseUrl } from './testDatabase.js';
// @ts-expect-error a plain ES module without types
import { evmAccount, keccak256 } from '../agent-client/client.mjs';
// @ts-expect-error a plain ES module without types
import { bountyAim, decideHunter, hunterMemory, readArcBounties } from '../agent-client/examples/congo-hunter.mjs';
// @ts-expect-error a plain ES module without types
import { checkArcBounty, decideSurvivor, readNotices, survivorMemory } from '../agent-client/examples/congo-survivor.mjs';

const clientScriptPath = fileURLToPath(new URL('../agent-client/client.mjs', import.meta.url));
const examplesDir = fileURLToPath(new URL('../agent-client/examples/', import.meta.url));
const speciesDir = fileURLToPath(new URL('../../../config/species-congo', import.meta.url));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the starter agents, as the server publishes them', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const world = createWorld({ seed: 7, speciesDir, terrainProfile: 'congo_v1', initialAgents: { blue_duiker: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    app = Fastify();
    installLiveAgents(app, { live: new LiveLayer(port, null), world: port, store: { count: async () => 0 } as never, ledger: null,
      limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  it('serves each example with its hash, and lists them all in /agents/info and the guide', async () => {
    const info = (await app.inject({ url: '/agents/info' })).json();
    const names = readdirSync(examplesDir).filter((n) => EXAMPLE_NAME.test(n)).sort();
    expect(names).toEqual(expect.arrayContaining(['congo-hunter.mjs', 'congo-survivor.mjs']));
    expect(info.examples.map((e: { name: string }) => e.name)).toEqual(names);
    const guide = (await app.inject({ url: '/agents/guide.txt' })).body;
    for (const example of info.examples as Array<{ name: string; path: string; sha256: string }>) {
      expect(example.path).toBe(`/agents/examples/${example.name}`);
      const res = await app.inject({ url: example.path });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/javascript/);
      expect(res.headers['x-content-sha256']).toBe(example.sha256);
      // Exactly the file in the repository: the hash people check is the file they run.
      expect(res.body).toBe(readFileSync(join(examplesDir, example.name), 'utf8'));
      expect(sha256(res.body)).toBe(example.sha256);
      expect(guide).toContain(example.sha256);
      expect(guide).toContain(`/agents/examples/${example.name}`);
    }
    // Arc bounties are not on here, so the guide does not promise them.
    expect(guide).not.toMatch(/Arc bounties|WILDSENTIA_WALLET_KEY/);
  });

  it('where Arc bounties run, the guide explains them and warns that the wallet key must be a testnet throwaway', async () => {
    const world = createWorld({ seed: 7, speciesDir, terrainProfile: 'congo_v1', initialAgents: { blue_duiker: 4 }, minPopulation: {} });
    const port = worldPort(() => world, () => 'w1');
    const withBounties = Fastify();
    installLiveAgents(withBounties, { live: new LiveLayer(port, null), world: port, store: { count: async () => 0 } as never, ledger: null,
      limits: { slots: 5, perNetworkPerDay: 5 }, networkSecret: 's', clientScriptPath, arcBounties: { adminToken: null, now: () => 0 } as never });
    const guide = (await withBounties.inject({ url: '/agents/guide.txt' })).body;
    expect(guide).toMatch(/Hunters are never told which animal carries one/);
    expect(guide).toMatch(/WILDSENTIA_WALLET_KEY[\s\S]*Arc Testnet only, never a real wallet's key/);
    await withBounties.close();
  });

  it('answers 404 for any other name: unknown, another file, a path out of the folder', async () => {
    for (const url of ['/agents/examples/nope.mjs', '/agents/examples/congo-hunter.js', '/agents/examples/CONGO-HUNTER.mjs',
      '/agents/examples/..%2Fclient.mjs', '/agents/examples/..%2F..%2Fsrc%2Flive%2Froutes.ts', '/agents/examples/%2e%2e%2fmcp.mjs',
      '/agents/examples/.congo-hunter.mjs', '/agents/examples/congo-hunter.mjs%00.txt', '/agents/examples/']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('import ');
    }
  });
});

describe('the client signs a payout wallet proof with no dependencies', () => {
  it('hashes as Ethereum does, and its personal_sign matches a wallet byte for byte', async () => {
    expect(Buffer.from(keccak256(new Uint8Array())).toString('hex')).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    for (let i = 0; i < 5; i++) {
      const key = generatePrivateKey(), wallet = privateKeyToAccount(key), mine = evmAccount(key);
      expect(mine.address).toBe(wallet.address);
      const message = `Wildsentia payout wallet\nAgent: ag_${i}\nWallet: ${wallet.address.toLowerCase()}\nWorld: vana:w1`;
      const signature = mine.signMessage(message);
      expect(signature).toBe(await wallet.signMessage({ message }));
      expect(await recoverMessageAddress({ message, signature })).toBe(wallet.address);
    }
    // A bad key is refused, and the refusal never repeats it.
    expect(() => evmAccount('0x1234')).toThrow(/32 bytes of hex/);
    try { evmAccount(`0x${'f'.repeat(64)}`); } catch (e) { expect(String((e as Error).message)).not.toContain('ffff'); }
  });
});

const animal = (over: Record<string, unknown> = {}) => ({ id: 'blue_duiker_0001', speciesId: 'blue_duiker', position: { x: 0, z: 0 }, moving: false, action: 'idle',
  gait: 'walk', stamina: 1, drives: { hunger: 0.1, thirst: 0.1 }, tree: null, perched: false, carcassBeside: false, ...over });
const leopardNear = (distance: number, over: Record<string, unknown> = {}) => ({ id: 'african_leopard_0002', speciesId: 'african_leopard', x: distance, z: 0, distance,
  predator: true, huntsYou: true, chasingYou: false, steeredByAgent: null, ...over });
const duikerGuide = { senses: { sightM: 25 }, escape: { noticesThreatsAtM: 30, fleesAtM: 15 } };

describe('the survivor decides', () => {
  const calm = () => survivorMemory('blue_duiker', () => 0.5);
  it('takes its species, runs from a charging leopard at a run, and away from it', () => {
    expect(decideSurvivor({ animal: null }, calm())).toMatchObject({ kind: 'possess', target: 'blue_duiker' });
    const step = decideSurvivor({ animal: animal(), nearby: [leopardNear(20, { chasingYou: true })], guide: duikerGuide }, calm());
    expect(step).toMatchObject({ kind: 'flee', gait: 'run' });
    expect(step.points[0].x).toBeLessThan(-100);
  });
  it('drinks when thirsty and feeds when hungry; ignores a leopard far off', () => {
    const water = [{ x: 30, z: 0, litres: 100, distance: 30 }];
    expect(decideSurvivor({ animal: animal({ drives: { hunger: 0.1, thirst: 0.7 } }), water, nearby: [leopardNear(150)], guide: duikerGuide }, calm()))
      .toMatchObject({ kind: 'goTo', to: { x: 30, z: 0 }, goal: 'water' });
    expect(decideSurvivor({ animal: animal({ drives: { hunger: 0.7, thirst: 0.1 } }), water, guide: duikerGuide }, calm())).toMatchObject({ kind: 'act', action: 'graze' });
  });
  it('reads the bounty notice for its animal and then plays carefully', () => {
    const mem = calm();
    const o = { animal: animal({ drives: { hunger: 0.1, thirst: 0.4 } }), water: [{ x: 30, z: 0, litres: 100, distance: 30 }], nearby: [leopardNear(50)], guide: duikerGuide,
      notices: [{ at: 5, text: 'Your animal (blue_duiker_0001) carries a 2.5 USDC bounty on Arc. Keep it alive and in your control for 72 world hours (about 6.0 real hours) and it is paid to your wallet 0xabc. Hunters are not told which animal it is; an agent whose predator kills it takes the bounty.' }] };
    // Before the notice: a leopard 50 m off is no threat yet, and thirst 0.4 can wait.
    expect(decideSurvivor({ ...o, notices: [] }, mem)).toMatchObject({ kind: 'act', action: 'rest' });
    expect(readNotices(o, mem, 1000)).toHaveLength(1);
    expect(mem.bounty).toMatchObject({ animalId: 'blue_duiker_0001', usdc: 2.5 });
    // Read once only.
    expect(readNotices(o, mem, 2000)).toHaveLength(0);
    // Careful: the same leopard is now a threat, so it moves away (a trot: it is not on it yet).
    expect(decideSurvivor(o, mem)).toMatchObject({ kind: 'flee', gait: 'trot' });
    // With no hunter in sight it drinks at lower thirst; with one in sight it does not go for water.
    expect(decideSurvivor({ ...o, nearby: [] }, mem)).toMatchObject({ kind: 'goTo', goal: 'water' });
    expect(decideSurvivor({ ...o, nearby: [leopardNear(120)] }, mem)).toMatchObject({ kind: 'act', action: 'rest' });
    // Another animal (after a death) is not careful about someone else's bounty.
    expect(decideSurvivor({ ...o, animal: { ...o.animal, id: 'blue_duiker_0009' }, nearby: [leopardNear(50)] }, mem)).toMatchObject({ kind: 'act', action: 'rest' });
  });
  it('counts a bounty on its animal read from GET /agents/me/arc-bounties, even with the notice missed; every half minute', async () => {
    const mem = calm(); let reads = 0;
    const api = { arcBounties: async () => { reads++; return { live: [], yours: [{ bountyId: '0xb1', targetAnimalId: 'blue_duiker_0001', amountAtomic: '1500000' }] }; } };
    const o = { animal: animal() };
    await checkArcBounty(api, o, mem, 1000);
    expect(mem.bounty).toMatchObject({ animalId: 'blue_duiker_0001', usdc: 1.5 });
    await checkArcBounty(api, o, mem, 20_000);
    expect(reads).toBe(1);
    await checkArcBounty(api, { animal: animal({ id: 'blue_duiker_0002' }) }, survivorMemory(), 1000);
    expect(reads).toBe(2);
  });
});

describe('the hunter decides', () => {
  const leopard = (over: Record<string, unknown> = {}) => animal({ id: 'african_leopard_0003', speciesId: 'african_leopard', ...over });
  const duiker = (id: string, distance: number, over: Record<string, unknown> = {}) => ({ id, speciesId: 'blue_duiker', x: distance, z: 0, distance, predator: false,
    huntsYou: false, chasingYou: false, steeredByAgent: null, ...over });
  const base = { huntable: ['blue_duiker', 'water_chevrotain'], guide: { senses: { sightM: 40 } } };
  it('hunts the nearest eligible prey in sight, agent-steered or wild, and never a predator', () => {
    const o = { ...base, animal: leopard(), nearby: [leopardNear(10, { huntsYou: false }), duiker('blue_duiker_0004', 35, { steeredByAgent: 'Someone' }), duiker('blue_duiker_0005', 30)] };
    expect(decideHunter(o, hunterMemory())).toMatchObject({ kind: 'hunt', id: 'blue_duiker_0005' });
    const mem = hunterMemory(); mem.skip.blue_duiker_0005 = Date.now() + 60_000;
    expect(decideHunter(o, mem)).toMatchObject({ kind: 'hunt', id: 'blue_duiker_0004' });
  });
  it('stalks prey it senses beyond sight, waits out a hunt, feeds on a kill and ranges with nothing near', () => {
    expect(decideHunter({ ...base, animal: leopard(), nearby: [duiker('blue_duiker_0006', 90)] }, hunterMemory())).toMatchObject({ kind: 'goTo', goal: 'prey', gait: 'walk', to: { x: 90, z: 0 } });
    expect(decideHunter({ ...base, animal: leopard({ action: 'hunt', hunting: 'blue_duiker_0006' }), nearby: [] }, hunterMemory())).toMatchObject({ kind: 'wait' });
    expect(decideHunter({ ...base, animal: leopard({ carcassBeside: true, drives: { hunger: 0.5, thirst: 0.1 } }), nearby: [] }, hunterMemory())).toMatchObject({ kind: 'act', action: 'feed' });
    expect(decideHunter({ ...base, animal: leopard(), nearby: [] }, hunterMemory())).toMatchObject({ kind: 'goTo', goal: 'range' });
    expect(decideHunter({ animal: null }, hunterMemory())).toMatchObject({ kind: 'possess', target: 'african_leopard' });
  });
  it('keeps itself fit: tops up and rests when its fitness is low, and takes the weakest-looking prey', () => {
    const unfit = { score: 0.45, label: 'weak' };
    // Worn out and unfit with no prey close: it rests rather than ranging.
    expect(decideHunter({ ...base, animal: leopard({ fitness: unfit, drives: { hunger: 0.3, thirst: 0.2, fatigue: 0.7 } }), nearby: [] }, hunterMemory()))
      .toMatchObject({ kind: 'act', action: 'rest' });
    // Spent, it rests however fit it still is.
    expect(decideHunter({ ...base, animal: leopard({ fitness: { score: 0.67, label: 'fair' }, drives: { hunger: 0.1, thirst: 0.2, fatigue: 1 } }), nearby: [] }, hunterMemory()))
      .toMatchObject({ kind: 'act', action: 'rest' });
    // Unfit, it drinks at a thirst a fit one would ignore.
    const water = [{ x: 30, z: 0, litres: 100, distance: 30 }];
    expect(decideHunter({ ...base, animal: leopard({ fitness: unfit, drives: { hunger: 0.2, thirst: 0.4, fatigue: 0.1 } }), nearby: [], water }, hunterMemory()))
      .toMatchObject({ kind: 'goTo', goal: 'water' });
    expect(decideHunter({ ...base, animal: leopard({ fitness: { score: 0.9, label: 'fit' }, drives: { hunger: 0.2, thirst: 0.4, fatigue: 0.1 } }), nearby: [], water }, hunterMemory()))
      .toMatchObject({ goal: 'range' });
    // Of two duikers about as near, the weak-looking one, though a little farther.
    const o = { ...base, animal: leopard(), nearby: [duiker('blue_duiker_0008', 20, { looks: 'fit' }), duiker('blue_duiker_0009', 28, { looks: 'weak' })] };
    expect(decideHunter(o, hunterMemory())).toMatchObject({ kind: 'hunt', id: 'blue_duiker_0009' });
  });

  it('reads the live Arc bounties, heads for the region of one it can take, and goes for that species first there', async () => {
    const lines: string[] = [], mem = hunterMemory();
    const bounty = (over: Record<string, unknown>) => ({ bountyId: '0x01', status: 'active', speciesId: 'water_chevrotain', region: 'r1_0', amountAtomic: '1000000',
      area: { x: 2000, z: 0, sizeM: 1500 }, youCanTake: true, inYourRegion: false, ...over });
    let live = [bounty({}), bounty({ bountyId: '0x02', amountAtomic: '3000000', youCanTake: false }), bounty({ bountyId: '0x03', amountAtomic: '2000000', region: 'r2_0', area: { x: -2000, z: 0, sizeM: 1500 } })];
    let you: unknown = null;
    const api = { arcBounties: async () => ({ live, yours: [], results: [], you }) };
    // Before it steers an animal, nothing is told: whether it can take one is not known yet.
    await readArcBounties(api, mem, (l: string) => lines.push(l), -60_000);
    expect(lines).toHaveLength(0);
    you = { animalId: 'african_leopard_0003', speciesId: 'african_leopard', region: 'r0_0', x: 0, z: 0 };
    await readArcBounties(api, mem, (l: string) => lines.push(l), 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('not prey a african leopard can take');
    // The largest it can take, in another region: a leg of 400 m toward its middle.
    expect(bountyAim(mem)).toMatchObject({ bountyId: '0x03' });
    expect(decideHunter({ ...base, animal: leopard(), nearby: [] }, mem)).toMatchObject({ kind: 'goTo', goal: 'bounty', to: { x: -400, z: 0 } });
    // In its region: the bounty's species before a nearer duiker.
    live = [bounty({ inYourRegion: true })];
    await readArcBounties(api, mem, (l: string) => lines.push(l), 10_000);
    expect(lines).toHaveLength(3);
    await readArcBounties(api, mem, (l: string) => lines.push(l), 40_000);
    expect(bountyAim(mem)).toMatchObject({ bountyId: '0x01' });
    const o = { ...base, animal: leopard(), nearby: [duiker('blue_duiker_0007', 10), { ...duiker('water_chevrotain_0001', 25), speciesId: 'water_chevrotain' }] };
    expect(decideHunter(o, mem)).toMatchObject({ kind: 'hunt', id: 'water_chevrotain_0001' });
    expect(decideHunter({ ...base, animal: leopard(), nearby: [] }, mem)).toMatchObject({ kind: 'goTo', goal: 'range' });
    // A server without Arc bounties: nothing read, the hunter as before.
    const plain = hunterMemory();
    await readArcBounties({}, plain, () => undefined, 0);
    expect(bountyAim(plain)).toBeNull();
  });
});

// The 5-minute promise, end to end: both starter agents run as people run them (node, a URL, a
// testnet key), against a Congo world in free play. The survivor is told of a bounty on its animal.
const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;

maybe('the starter agents, run as programs', () => {
  let app: FastifyInstance, live: LiveLayer, store: AgentStore, base = '', ticker: NodeJS.Timeout | undefined;
  const commands: Array<{ agentId: string; command: string; args: Record<string, unknown> }> = [];
  const world = createWorld({ seed: 11, speciesDir, terrainProfile: 'congo_v1', initialAgents: { african_leopard: 10, blue_duiker: 60 }, minPopulation: {} });
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    await migrate(pool!);
    await pool!.query('truncate live_possessions, live_agents cascade');
    const port = worldPort(() => world, () => 'w-starter');
    live = new LiveLayer(port, null);
    live.onCommand = (record) => { commands.push(record); };
    store = new AgentStore(pool!);
    app = Fastify();
    installLiveAgents(app, { live, world: port, store, ledger: null, limits: { slots: 10, perNetworkPerDay: 10 }, networkSecret: 's', clientScriptPath });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    ticker = setInterval(() => { try { live.tick(0.25); } catch { /* stepping */ } }, 50);
  }, 120_000);
  afterAll(async () => { for (const c of children) c.kill('SIGKILL'); clearInterval(ticker); await app?.close(); await pool?.end(); });

  const run = (file: string, env: Record<string, string>, args: string[] = []) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VANA_|WILDSENTIA_)/.test(k))) as Record<string, string>;
    const child = spawn(process.execPath, [file, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (d) => { out += d; }); child.stderr!.on('data', (d) => { out += d; });
    return {
      output: () => out,
      async until(re: RegExp, ms = 30_000) {
        const end = Date.now() + ms;
        while (!re.test(out)) {
          if (Date.now() > end || child.exitCode !== null) throw new Error(`waited for ${re}:\n${out}`);
          await sleep(100);
        }
        return re.exec(out)!;
      },
      async stop() { if (child.exitCode === null) { child.kill('SIGINT'); await new Promise((r) => child.once('exit', r)); } },
    };
  };

  it('registers, proves a testnet wallet, plays, hears of its bounty and plays carefully; a rerun from the downloaded files is the same agent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'starter-home-')), key = generatePrivateKey(), wallet = privateKeyToAccount(key).address;
    const survivor = run(join(examplesDir, 'congo-survivor.mjs'), { HOME: home, WILDSENTIA_URL: base, WILDSENTIA_WALLET_KEY: key });
    const [, agentId] = await survivor.until(/registered as Survivor \w+ \((ag_[0-9a-f]{16})\)/);
    await survivor.until(new RegExp(`payout wallet ${wallet} is proven`));
    expect(survivor.output()).toMatch(/TESTNET|Arc Testnet only/);
    const [, animalId] = await survivor.until(/now steering (blue_duiker_[0-9a-f]+)/);
    expect((await store.byId(agentId!))).toMatchObject({ wallet: wallet.toLowerCase(), walletProven: true });
    live.notify(agentId!, `Your animal (${animalId}) carries a 1 USDC bounty on Arc. Keep it alive and in your control for 72 world hours (about 6.0 real hours) and it is paid to your wallet ${wallet.toLowerCase()}. Hunters are not told which animal it is; an agent whose predator kills it takes the bounty.`);
    await survivor.until(new RegExp(`BOUNTY: 1 USDC on ${animalId}`));
    await survivor.until(/lying low|moving away|running away|thirsty|hungry/);
    await survivor.stop();
    // Stopping does not let the animal go: the bounty needs the same agent to hold it.
    expect(live.avatars.get(agentId!)?.animalId).toBe(animalId);
    // The key is never printed, with or without its 0x.
    expect(survivor.output()).not.toContain(key.slice(2));

    // As downloaded: client.mjs and the example side by side, run again with the same home.
    const flat = mkdtempSync(join(tmpdir(), 'starter-flat-'));
    copyFileSync(clientScriptPath, join(flat, 'client.mjs')); copyFileSync(join(examplesDir, 'congo-survivor.mjs'), join(flat, 'congo-survivor.mjs'));
    const again = run(join(flat, 'congo-survivor.mjs'), { HOME: home, WILDSENTIA_URL: base });
    await again.until(new RegExp(`welcome back, Survivor \\w+ \\(${agentId}\\)`));
    await again.until(/No payout wallet|resting|lying low|feeding|drinking|wandering|going to water/);
    await again.stop();
    expect(await store.count()).toBe(1);
  }, 120_000);

  it('the hunter takes a leopard and hunts a duiker it senses', async () => {
    const hunter = run(join(examplesDir, 'congo-hunter.mjs'), { HOME: mkdtempSync(join(tmpdir(), 'starter-home-')), WILDSENTIA_URL: base });
    const [, agentId] = await hunter.until(/registered as Hunter \w+ \((ag_[0-9a-f]{16})\)/);
    await hunter.until(/now steering african_leopard_[0-9a-f]+/);
    expect(hunter.output()).toMatch(/hidden from hunters/);
    // Staged as if it had ranged there: the leopard stands 20 m from a wild duiker.
    const prey = world.agents.find((a) => a.alive && a.speciesId === 'blue_duiker' && !a.controller)!;
    const avatar = live.avatars.get(agentId!)!;
    avatar.x = prey.position!.x + 20; avatar.z = prey.position!.z; avatar.path = []; avatar.moving = false;
    await hunter.until(/hunting blue_duiker_[0-9a-f]+/);
    for (let i = 0; i < 50 && !commands.some((c) => c.agentId === agentId && c.command === 'hunt'); i++) await sleep(100);
    expect(commands).toContainEqual(expect.objectContaining({ agentId, command: 'hunt' }));
    await hunter.stop();
  }, 120_000);
});
