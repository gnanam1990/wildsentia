#!/usr/bin/env node
// A ready-to-run Wildsentia hunter (Node 22, nothing to install): it takes an African leopard,
// keeps it watered, looks for prey it can hunt among what it senses, and hunts again and again.
// Arc bounties sit on prey animals the hunters are never shown: any duiker it kills may carry
// one, and if it does, the USDC is paid to this agent's proven payout wallet. It reads the live
// bounties (amount, species, region) every half minute, ranges in the region of the best one its
// species can take, and goes for that species first.
//
//   curl -O <server>/agents/client.mjs && curl -O <server>/agents/examples/congo-hunter.mjs
//   WILDSENTIA_URL=<server> node congo-hunter.mjs [species]       # default african_leopard
//
//   WILDSENTIA_URL      the server's agent API (default http://127.0.0.1:8090, the local demo)
//   WILDSENTIA_WALLET_KEY  optional: a hex private key whose wallet is proven as the payout wallet.
//                       A TESTNET-only throwaway key, never a real wallet's: it is read from the
//                       environment, signs one message here and is never sent or printed.
//   WILDSENTIA_NAME     the agent's name on its first run (later runs keep the registered one)
//   WILDSENTIA_PROFILE  which saved key to use (default one per role and server, in ~/.vana-agent/)
//
// The agent's Ed25519 key is saved on first run, so a rerun is the same agent (registrations
// are limited per network and day). With --mcp it instead runs the owned-animal walk-through
// below over the MCP bridge (../mcp.mjs), as an MCP client would.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

/** A file beside this one (as downloaded), or one folder up (in the repository). */
const beside = (name) => [`./${name}`, `../${name}`].map((p) => new URL(p, import.meta.url)).find((u) => existsSync(fileURLToPath(u))) ?? null;

/** Whether this module is the program being run, however its path was spelled (spaces, symlinks). */
export function isMain(moduleUrl, argv1) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(moduleUrl)) === real(argv1);
}

/** A minimal MCP client over a child process's stdio. */
export function mcpClient(env = process.env) {
  const bridge = beside('mcp.mjs');
  if (!bridge) throw new Error('mcp.mjs not found beside this file or one folder up');
  const child = spawn(process.execPath, [fileURLToPath(bridge)], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1, gone = null;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; } // not a protocol line
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  // If the bridge stops, every waiting request fails instead of hanging.
  const stop = (why) => { gone = why; for (const settle of pending.values()) settle({ error: { message: why } }); pending.clear(); };
  child.on('exit', (code) => stop(`the MCP bridge exited (${code})`));
  child.on('error', (e) => stop(`the MCP bridge failed to start: ${e.message}`));
  const request = (method, params) => new Promise((resolve, reject) => {
    if (gone) { reject(new Error(gone)); return; }
    const id = next++;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });
  return {
    async start() {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'congo-hunter', version: '1.0.0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return init;
    },
    tools: async () => (await request('tools/list')).tools,
    /** Calls a tool; returns its parsed result, throwing the server's refusal as an error. */
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      const value = JSON.parse(result.content[0].text);
      if (result.isError) throw Object.assign(new Error(value.error), { refusal: value });
      return value;
    },
    close: () => { child.stdin.end(); child.kill(); },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The Congo prey a leopard hunts: clues to any other bounty are not worth its time. */
const prey = (clues = []) => clues.filter((c) => c.speciesId === 'blue_duiker' || c.speciesId === 'water_chevrotain');

/**
 * Where a clue points (spec §6): past fresh tracks the way the target went, or toward a call it
 * heard. The freshest clue leads; disturbance says only "it was here", so it points nowhere.
 */
export function followClue(at, clues = []) {
  const clue = clues.filter((c) => c.kind === 'tracks' || c.kind === 'call').sort((a, b) => a.ageWorldSeconds - b.ageWorldSeconds)[0];
  if (!clue) return null;
  const toward = (from, degrees, metres) => {
    const r = degrees * Math.PI / 180;
    return { x: Math.round(from.x + Math.sin(r) * metres) + 0, z: Math.round(from.z + Math.cos(r) * metres) + 0 };
  };
  if (clue.kind === 'tracks')
    return clue.headingDeg === undefined ? { x: clue.x, z: clue.z, gait: 'walk' } : { ...toward(clue, clue.headingDeg, 40), gait: 'walk' };
  return { ...toward(at, clue.bearingDeg, clue.distance === 'near' ? 50 : 120), gait: 'trot' };
}
/** A leopard charges from about this close; nearer than that the hunt command closes the gap. */
const CHARGE_M = 30;

/**
 * The MCP walk-through (owned animals, spec §7): one hunt of a sensed bounty target, returning what happened. `log` receives a line per step; `tick` waits between steps
 * (the world moves in real time).
 */
export async function hunt(mcp, { log = console.log, tick = () => wait(2000), maxSteps = 120, afterTakeControl = async () => undefined } = {}) {
  const mine = await mcp.call('get_my_animals');
  const leopard = mine.animals.find((a) => a.speciesId === 'african_leopard' && a.life?.status === 'alive');
  if (!leopard) return { ok: false, reason: 'no_leopard_authorised' };
  await mcp.call('take_control', { animalId: leopard.life.animalId });
  log(`steering ${leopard.life.animalId}`);
  await afterTakeControl();
  // A refused move (no land route to a target in water, the world busy) is not the end of the hunt.
  const move = (to) => mcp.call('move_to', to).catch((e) => { log(`move refused: ${e.refusal?.error ?? e.message}`); return null; });
  let centre = null, lastSeenSteps = 0;
  for (let step = 0; step < maxSteps; step++) {
    const seen = await mcp.call('observe_animal'), board = await mcp.call('get_nearby_bounties');
    if (!seen.animal) return { ok: false, reason: 'lost_control' };
    centre ??= seen.animal.position;
    const target = seen.nearby.find((a) => a.bounty);
    if (target) {
      lastSeenSteps = 0;
      log(`sensed bounty target ${target.id} (${target.sense}) at ${target.distance} m`);
      // Stalk to charging distance; the hunt command runs the charge itself.
      if (target.distance > CHARGE_M) await move({ x: target.x, z: target.z, gait: target.distance > 60 ? 'trot' : 'run' });
      else {
        const result = await mcp.call('hunt', { animalId: target.id }).catch((e) => e.refusal ?? { ok: false, error: e.message });
        log(`hunt: ${JSON.stringify(result)}`);
        // Only a hunt the server accepted counts.
        if (result?.ok === true) return { ok: true, target: target.id, bountyId: target.bounty.bountyId };
      }
    } else if (board.lastSeen?.length && lastSeenSteps < 8) {
      // Head for where it was last sensed, for a while; then range again.
      lastSeenSteps++;
      const last = board.lastSeen[0];
      log(`heading for where bounty ${last.bountyId} was last seen`);
      await move({ x: last.x, z: last.z, gait: 'trot' });
    } else if (followClue(seen.animal.position, prey(board.clues))) {
      // Fresh tracks or a call of prey a leopard hunts: follow where they lead.
      const to = followClue(seen.animal.position, prey(board.clues));
      log(`following a clue to (${to.x}, ${to.z})`);
      await move(to);
    } else {
      // Range: a widening spiral round where the hunt began, so its senses sweep new ground.
      const a = step * 0.9, r = 80 + step * 20;
      await move({ x: centre.x + Math.cos(a) * r, z: centre.z + Math.sin(a) * r, gait: 'walk' });
    }
    await tick();
  }
  return { ok: false, reason: 'not_found' };
}

// The starter hunter: free play, through client.mjs.

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** How long a refused hunt keeps that animal off the list: out of sight a moment, wrong prey for good. */
const SKIP_MS = { out_of_sight: 6_000, incompatible_prey: 10 * 60_000, not_its_prey: 60 * 60_000, no_such_animal: 60 * 60_000 };

export function hunterMemory(species = 'african_leopard') { return { species, home: null, goal: null, leg: 0, skip: {}, seenAt: 0, said: '', kills: 0, arc: null, fitness: null }; }

/** How far one leg toward a bounty's region goes: a long route is walked in legs, re-aimed each time. */
const LEG_M = 400;

/**
 * The live Arc bounty worth going for, from GET /agents/me/arc-bounties as last read: one this
 * species can take, in its own region first, then the largest. Null with none.
 */
export function bountyAim(mem) {
  const live = (mem.arc?.live ?? []).filter((b) => b.youCanTake && b.status === 'active');
  return live.sort((x, y) => Number(y.inYourRegion) - Number(x.inYourRegion) || Number(BigInt(y.amountAtomic) - BigInt(x.amountAtomic)))[0] ?? null;
}

/** A point at most `metres` from `here` toward `to`. */
export function toward(here, to, metres) {
  const d = dist(here, to);
  if (d <= metres) return { x: Math.round(to.x), z: Math.round(to.z) };
  return { x: Math.round(here.x + (to.x - here.x) / d * metres), z: Math.round(here.z + (to.z - here.z) / d * metres) };
}

/** The notices not read yet, oldest first (the server keeps the last few). */
export function freshNotices(o, mem) {
  const fresh = (o.notices ?? []).filter((n) => n.at > mem.seenAt);
  if (fresh.length) mem.seenAt = Math.max(...fresh.map((n) => n.at));
  return fresh;
}

/** A point `metres` from `here`, straight away from `from`. */
export function awayFrom(here, from, metres, turnDeg = 0) {
  const t = turnDeg * Math.PI / 180, dx = here.x - from.x, dz = here.z - from.z, d = Math.hypot(dx, dz) || 1;
  const ux = dx / d, uz = dz / d;
  return { x: Math.round(here.x + (ux * Math.cos(t) - uz * Math.sin(t)) * metres), z: Math.round(here.z + (ux * Math.sin(t) + uz * Math.cos(t)) * metres) };
}

/**
 * The hunter's next step from one observation: a pure function, so it can be read and tested.
 * Escape anything hunting it, finish a hunt or a meal, drink when thirsty, then hunt the nearest
 * eligible prey it senses (a sensed bounty target first, where the world shows one), creeping
 * closer while it is out of sight; with nothing sensed, range in a widening spiral round home.
 */
export function decideHunter(o, mem, now = Date.now()) {
  const a = o.animal;
  if (!a) return { kind: 'possess', target: mem.species, why: `taking a ${mem.species}` };
  const here = a.position, nearby = o.nearby ?? [], drives = a.drives ?? {};
  mem.home ??= { x: here.x, z: here.z };
  const wait = (why) => ({ kind: 'wait', why });
  const chaser = nearby.find((n) => n.chasingYou) ?? nearby.find((n) => n.huntsYou && n.distance < 40);
  if (chaser) {
    // A climber's best escape is up its patch's tree.
    if (a.tree && dist(a.tree, here) < 40) {
      if (a.perched) return wait(`up a tree, away from a ${chaser.speciesId}`);
      return dist(a.tree, here) > 3.5 ? { kind: 'move', points: [{ x: a.tree.x, z: a.tree.z }], gait: 'run', goal: 'tree', why: `running for a tree from a ${chaser.speciesId}` }
        : { kind: 'climb', why: `climbing away from a ${chaser.speciesId}` };
    }
    return { kind: 'flee', points: [0, 50, -50].map((t) => awayFrom(here, chaser, 150, t)), gait: 'run', why: `running from a ${chaser.speciesId}` };
  }
  if (a.action === 'hunt') return wait(`on the hunt (${a.hunting})`);
  if (a.carcassBeside && (drives.hunger ?? 0) > 0.1) return a.action === 'feed' ? wait('feeding') : { kind: 'act', action: 'feed', why: 'feeding on the kill' };
  // A fitter animal runs faster and longer and holds its prey better (animal.fitness): below fair,
  // it tops up before it hunts again, at lower thirst, and rests off its fatigue.
  const unfit = (a.fitness?.score ?? 1) < 0.6;
  const water = o.water?.[0];
  if (water && ((drives.thirst ?? 0) > (unfit ? 0.3 : 0.6) || (a.action === 'drink' && (drives.thirst ?? 0) > 0.1))) {
    if (water.distance > 2) return a.moving && mem.goal?.kind === 'water' ? wait('walking to water') : { kind: 'goTo', to: { x: water.x, z: water.z }, gait: 'walk', goal: 'water', why: 'thirsty: going to water' };
    return a.action === 'drink' ? wait('drinking') : { kind: 'act', action: 'drink', why: 'drinking' };
  }
  const worn = (drives.fatigue ?? 0) > 0.8 || (unfit && (drives.fatigue ?? 0) > 0.45);
  if (worn && !nearby.some((n) => (o.huntable ?? []).includes(n.speciesId) && n.distance < 25))
    return a.action === 'rest' ? wait('resting to get fit for the next hunt')
      : { kind: 'act', action: 'rest', why: `resting: worn out${a.fitness ? ` (fitness ${Math.round(a.fitness.score * 100)}%)` : ''}` };
  // A sensed target first, then the species a live bounty in this region is on, then the weakest-looking, then the nearest.
  const aim = bountyAim(mem), wanted = (n) => Number(!!aim && aim.inYourRegion && n.speciesId === aim.speciesId);
  // A weak animal is slower and easier to hold: of prey about as near, take the weakest-looking.
  const frailty = (n) => (n.looks === 'weak' ? 2 : n.looks === 'fair' ? 1 : 0) * Number(n.distance < 60);
  const prey = nearby.filter((n) => (o.huntable ?? []).includes(n.speciesId) && !n.predator && !((mem.skip[n.id] ?? 0) > now))
    .sort((x, y) => Number(!!y.bounty) - Number(!!x.bounty) || wanted(y) - wanted(x) || frailty(y) - frailty(x) || x.distance - y.distance)[0];
  if (prey) {
    const sight = o.guide?.senses?.sightM ?? 40;
    if (prey.distance <= sight) return { kind: 'hunt', id: prey.id, at: { x: prey.x, z: prey.z },
      why: `hunting ${prey.id} at ${Math.round(prey.distance)} m${prey.looks === 'weak' ? ' (it looks weak)' : ''}${prey.bounty ? ' (a sensed bounty target)' : wanted(prey) ? ` (a ${aim.speciesId.replaceAll('_', ' ')} where a bounty is live)` : ' (any prey may carry a hidden bounty)'}` };
    // Sensed but not yet in sight (smell, hearing): creep closer at a walk, re-aimed as it moves.
    if (a.moving && mem.goal?.kind === 'prey' && dist(mem.goal, prey) < 10) return wait(`stalking ${prey.id}`);
    return { kind: 'goTo', to: { x: prey.x, z: prey.z }, gait: 'walk', goal: 'prey', why: `stalking ${prey.id} (${prey.sense ?? 'sensed'}, ${Math.round(prey.distance)} m)` };
  }
  // Fresh tracks or a call, where the world gives clues: follow where they lead.
  const clue = followClue(here, o.clues ?? []);
  if (clue && !(a.moving && mem.goal?.kind === 'clue')) return { kind: 'goTo', to: { x: clue.x, z: clue.z }, gait: clue.gait, goal: 'clue', why: 'following a clue' };
  // A live bounty this species can take, in another region: walk there, a leg at a time.
  if (aim?.area && !aim.inYourRegion) {
    if (a.moving && mem.goal?.kind === 'bounty') return wait(`heading for region ${aim.region}`);
    return { kind: 'goTo', to: toward(here, aim.area, LEG_M), gait: 'walk', goal: 'bounty',
      why: `heading for region ${aim.region}: a ${Number(aim.amountAtomic) / 1e6} USDC bounty is live on a ${aim.speciesId.replaceAll('_', ' ')} there` };
  }
  if (a.moving) return wait('ranging');
  // Range: a widening spiral round where it started (or round the bounty's region), so its senses sweep new ground.
  mem.leg++;
  const centre = aim?.area ?? mem.home, angle = mem.leg * 0.9, r = 80 + (mem.leg % 24) * 25;
  return { kind: 'goTo', to: { x: Math.round(centre.x + Math.cos(angle) * r), z: Math.round(centre.z + Math.sin(angle) * r) }, gait: 'walk', goal: 'range',
    why: aim ? `ranging for a ${aim.speciesId.replaceAll('_', ' ')} in region ${aim.region}` : 'ranging for prey' };
}

/** Carries out one step; a refusal is logged and remembered, never fatal. */
async function performHunter(api, step, mem, log, now) {
  const refused = (e) => e.body?.error ?? e.message;
  switch (step.kind) {
    case 'possess': {
      try {
        const p = await api.possess(step.target);
        if (p.queued) log(`no ${step.target} is free: waiting in line (place ${p.queued})`);
        else { log(`now steering ${p.animalId}`); mem.home = null; mem.goal = null; mem.arc = mem.arc && { ...mem.arc, at: -Infinity }; }
      } catch (e) {
        log(`could not take a ${step.target}: ${refused(e)}`);
        // Only owned animals here: take one this agent's owners authorised.
        if (e.body?.error === 'owned_only') {
          const mine = (await api.myAnimals().catch(() => ({ animals: [] }))).animals.find((x) => x.speciesId === step.target && x.life?.status === 'alive');
          if (mine) { await api.possess(mine.life.animalId).then((p) => log(`now steering ${p.animalId}`), (e2) => log(`could not take it: ${refused(e2)}`)); return; }
        }
        return 10_000;
      }
      return;
    }
    case 'hunt':
      try { await api.hunt(step.id); mem.goal = null; }
      catch (e) {
        const why = refused(e);
        mem.skip[step.id] = now + (SKIP_MS[why] ?? 6_000);
        log(`hunt refused: ${why}`);
        if (why === 'out_of_sight') await api.goTo(step.at, 'walk').then(() => { mem.goal = { kind: 'prey', ...step.at }; }, () => undefined);
      }
      return;
    case 'goTo':
      try { await api.goTo(step.to, step.gait); mem.goal = { kind: step.goal, ...step.to }; }
      catch (e) { log(`move refused: ${refused(e)}`); mem.goal = null; }
      return;
    case 'move':
    case 'flee':
      for (const p of step.points) {
        try { await api.move([p], step.gait); mem.goal = { kind: step.goal ?? 'flee', ...p }; return 1000; } catch { /* try the next way */ }
      }
      return 1000;
    case 'climb': await api.climb().catch((e) => log(`climb refused: ${refused(e)}`)); return 1000;
    case 'act': await api.act(step.action).catch((e) => log(`${step.action} refused: ${refused(e)}`)); return;
    default: return;
  }
}

/**
 * Reads the Arc bounties every half minute (a server without them, or a refusal, leaves none),
 * telling each live one once.
 */
export async function readArcBounties(api, mem, log, now) {
  if (!api.arcBounties || (mem.arc && now - mem.arc.at < 30_000)) return;
  const read = await api.arcBounties().catch(() => null);
  const told = mem.arc?.told ?? new Set();
  mem.arc = { at: now, live: read?.live ?? [], told };
  // Whether its species can take one is known only once it steers an animal: tell them then.
  if (!read?.you) return;
  for (const b of mem.arc.live) {
    if (told.has(b.bountyId)) continue;
    told.add(b.bountyId);
    log(`ARC BOUNTY live: ${Number(b.amountAtomic) / 1e6} USDC on a ${b.speciesId.replaceAll('_', ' ')} in region ${b.region}`
      + `${b.youCanTake ? (b.inYourRegion ? ' (this region: hunting that species first)' : ' (heading there)') : ' (not prey a ' + mem.species.replaceAll('_', ' ') + ' can take)'}`);
  }
}

/**
 * Plays until stopped (or for `steps` observations): observe, decide, act, every two seconds.
 * Commands also keep the animal from being released as idle.
 */
export async function playHunter(api, { species = 'african_leopard', log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), steps = Infinity, now = Date.now } = {}) {
  const mem = hunterMemory(species);
  let lastCommand = now();
  for (let i = 0; i < steps; i++) {
    let o;
    try { o = await api.observe(); } catch (e) { log(`observe: ${e.body?.error ?? e.message}`); await sleep(3000); continue; }
    for (const n of freshNotices(o, mem)) {
      log(`· ${n.text}`);
      if (/^You caught the /.test(n.text)) { mem.kills++; log('  a kill: if that animal carried a bounty, its USDC goes to this agent\'s proven wallet'); }
    }
    await readArcBounties(api, mem, log, now());
    const label = o.animal?.fitness?.label;
    if (label && label !== mem.fitness) { log(`fitness ${Math.round(o.animal.fitness.score * 100)}% (${label})`); mem.fitness = label; }
    const step = decideHunter(o, mem, now());
    if (step.why && step.why !== mem.said) { log(step.why); mem.said = step.why; }
    let pause;
    if (step.kind !== 'wait') { pause = await performHunter(api, step, mem, log, now()); lastCommand = now(); }
    else if (o.animal && now() - lastCommand > 5 * 60_000) { await api.presence().catch(() => undefined); lastCommand = now(); }
    if (i + 1 < steps) await sleep(pause ?? 2000);
  }
  return mem;
}

/** Loads client.mjs for this server, with one saved key per role and server. */
export async function connect(role, env = process.env) {
  const url = (env.WILDSENTIA_URL || env.VANA_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
  env.VANA_URL = url;
  env.VANA_PROFILE = env.WILDSENTIA_PROFILE || `${role}-${url.replace(/^https?:\/\//, '')}`.replace(/[^A-Za-z0-9_-]+/g, '-');
  const client = beside('client.mjs');
  if (!client) throw new Error(`client.mjs not found: download it next to this file (curl -O ${url}/agents/client.mjs)`);
  return { url, profile: env.VANA_PROFILE, client: await import(client.href) };
}

if (isMain(import.meta.url, process.argv[1])) {
  if (process.argv.includes('--mcp')) {
    const mcp = mcpClient();
    await mcp.start();
    // Whatever happens, the leopard goes back to the wild rather than waiting out an idle release.
    try { console.log(JSON.stringify(await hunt(mcp))); }
    finally { await mcp.call('release_control').catch(() => undefined); mcp.close(); }
  } else {
    // Read once and dropped from the environment, so nothing started from here inherits it.
    const walletKey = process.env.WILDSENTIA_WALLET_KEY;
    delete process.env.WILDSENTIA_WALLET_KEY;
    const species = process.argv[2] ?? process.env.WILDSENTIA_SPECIES ?? 'african_leopard';
    const { url, profile, client } = await connect('hunter');
    const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    try {
      log(`Wildsentia hunter on ${url} (key: ~/.vana-agent/${profile}.json)`);
      const me = await client.joinWorld({ name: process.env.WILDSENTIA_NAME || `Hunter ${client.agentId().slice(3, 7)}`,
        bio: 'A starter hunter: it hunts whatever prey it senses.', walletKey, log });
      if (!me.wallet) log('No payout wallet: a bounty this hunter wins cannot be paid. Set WILDSENTIA_WALLET_KEY to a TESTNET-only throwaway key to prove one.');
      log('Bounty targets are hidden from hunters: every prey animal it kills might carry one. Ctrl+C stops; the animal stays yours for 15 minutes.');
      process.on('SIGINT', () => { log('stopped'); process.exit(0); });
      await playHunter(client.api, { species, log });
    } catch (e) { console.error(`${e.message}${e.body ? ` ${JSON.stringify(e.body)}` : ''}`); process.exit(1); }
  }
}
