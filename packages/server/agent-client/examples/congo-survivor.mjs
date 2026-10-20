#!/usr/bin/env node
// A ready-to-run Wildsentia survivor (Node 22, nothing to install): it takes a prey animal (a
// blue duiker unless told otherwise), keeps it fed and watered, and runs from the predators it
// senses. When the server tells it that its animal carries an Arc bounty, it says so and plays
// carefully: it watches further, flees sooner, tops up food and water early, and stays put
// rather than wander. If the animal is alive and still steered by this agent at the bounty's
// deadline, the USDC is paid to this agent's proven payout wallet.
//
//   curl -O <server>/agents/client.mjs && curl -O <server>/agents/examples/congo-survivor.mjs
//   WILDSENTIA_URL=<server> node congo-survivor.mjs [species]     # default blue_duiker
//
//   WILDSENTIA_URL      the server's agent API (default http://127.0.0.1:8090, the local demo)
//   WILDSENTIA_WALLET_KEY  optional: a hex private key whose wallet is proven as the payout wallet.
//                       A TESTNET-only throwaway key, never a real wallet's: it is read from the
//                       environment, signs one message here and is never sent or printed.
//   WILDSENTIA_NAME     the agent's name on its first run (later runs keep the registered one)
//   WILDSENTIA_PROFILE  which saved key to use (default one per role and server, in ~/.vana-agent/)
//
// The agent's Ed25519 key is saved on first run, so a rerun is the same agent (registrations
// are limited per network and day). Stopping it does not release the animal: a bounty is paid
// only to the agent that still steers it, so run it again within 15 minutes to carry on.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A file beside this one (as downloaded), or one folder up (in the repository). */
const beside = (name) => [`./${name}`, `../${name}`].map((p) => new URL(p, import.meta.url)).find((u) => existsSync(fileURLToPath(u))) ?? null;

/** Whether this module is the program being run, however its path was spelled (spaces, symlinks). */
export function isMain(moduleUrl, argv1) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return real(fileURLToPath(moduleUrl)) === real(argv1);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** The server's private word to a prey agent whose animal now carries a bounty (arcBounties/engine.ts). */
const BOUNTY_NOTICE = /Your animal \(([^)]+)\) carries an? ([0-9.]+) USDC bounty/;
/** How long after a "charging at you" warning every hunter in sight counts as a threat. */
const ALARM_MS = 30_000;
/** A meal that has not lowered hunger in this long: the ground here is bare, so move on. */
const BARE_GROUND_MS = 3 * 60_000;

export function survivorMemory(species = 'blue_duiker', random = Math.random) {
  return { species, random, home: null, goal: null, seenAt: 0, said: '', bounty: null, alarmUntil: 0, grazing: null };
}

/**
 * Reads the notices not read yet (oldest first): a bounty on this agent's animal switches on
 * careful play for that animal; a charge sets off the alarm. Returns them for the log.
 */
export function readNotices(o, mem, now = Date.now()) {
  const fresh = (o.notices ?? []).filter((n) => n.at > mem.seenAt);
  if (fresh.length) mem.seenAt = Math.max(...fresh.map((n) => n.at));
  for (const n of fresh) {
    const bounty = BOUNTY_NOTICE.exec(n.text);
    if (bounty) mem.bounty = { animalId: bounty[1], usdc: Number(bounty[2]), text: n.text, since: now };
    if (/charging at you/i.test(n.text)) mem.alarmUntil = now + ALARM_MS;
  }
  return fresh;
}

/** Whether the animal steered now is the one with a bounty on it. */
export const careful = (o, mem) => !!mem.bounty && !!o.animal && mem.bounty.animalId === o.animal.id;

/** A point `metres` from `here`, away from the threats (nearest weigh most), turned by `turnDeg`. */
export function escapePoint(here, threats, metres, turnDeg = 0) {
  let dx = 0, dz = 0;
  for (const t of threats) { const d = Math.max(1, dist(here, t)); dx += (here.x - t.x) / (d * d); dz += (here.z - t.z) / (d * d); }
  const len = Math.hypot(dx, dz) || 1, r = turnDeg * Math.PI / 180, ux = dx / len, uz = dz / len;
  return { x: Math.round(here.x + (ux * Math.cos(r) - uz * Math.sin(r)) * metres), z: Math.round(here.z + (ux * Math.sin(r) + uz * Math.cos(r)) * metres) };
}

/**
 * The survivor's next step from one observation: a pure function, so it can be read and tested.
 * Run from what hunts it, then drink, eat and rest, then idle. With a bounty on its animal it
 * watches twice as far, flees at a run sooner, drinks and eats at lower thirst and hunger, never
 * goes for water or food with a hunter in sight, and rests in place instead of wandering.
 */
export function decideSurvivor(o, mem, now = Date.now()) {
  const a = o.animal;
  if (!a) return { kind: 'possess', target: mem.species, why: `taking a ${mem.species}` };
  const here = a.position, nearby = o.nearby ?? [], drives = a.drives ?? {}, safe = careful(o, mem);
  mem.home ??= { x: here.x, z: here.z };
  const wait = (why) => ({ kind: 'wait', why });
  const notices = o.guide?.escape?.noticesThreatsAtM ?? 30, fleesAt = o.guide?.escape?.fleesAtM ?? 15;
  const watch = (safe ? Math.max(60, notices * 2) : Math.max(35, notices)) * (mem.alarmUntil > now ? 1.5 : 1);
  const threats = nearby.filter((n) => n.chasingYou || (n.huntsYou && n.distance <= watch));
  if (threats.length) {
    const near = Math.min(...threats.map((t) => t.distance));
    const chased = threats.some((t) => t.chasingYou) || near <= fleesAt * (safe ? 3 : 2);
    if (a.tree && dist(a.tree, here) < 30) {
      if (a.perched) return wait('up a tree, out of reach');
      if (dist(a.tree, here) <= 3.5) return { kind: 'climb', why: 'climbing out of reach' };
    }
    const gait = chased && (a.stamina ?? 1) > 0.05 ? 'run' : 'trot';
    // Already running that way at that pace: keep going rather than resend the same order.
    if (a.moving && a.gait === gait && mem.goal?.kind === 'flee' && now - mem.goal.at < 4000) return wait(`fleeing from ${threats[0].speciesId}`);
    return { kind: 'flee', points: [0, 50, -50, 100, -100].map((t) => escapePoint(here, threats, safe ? 160 : 120, t)), gait,
      why: `${chased ? 'running' : 'moving'} away from ${threats.map((t) => `${t.speciesId} at ${Math.round(t.distance)} m`).join(', ')}` };
  }
  const hunterInSight = nearby.some((n) => n.huntsYou);
  const thirstAt = safe ? 0.35 : 0.55, hungerAt = safe ? 0.35 : 0.5;
  if ((a.stamina ?? 1) < 0.3) return a.action === 'rest' ? wait('catching its breath') : { kind: 'act', action: 'rest', why: 'catching its breath' };
  // With a bounty on it, a trip for water or food waits until no hunter is in sight.
  const outing = !(safe && hunterInSight);
  const water = o.water?.[0], thirst = drives.thirst ?? 0, hunger = drives.hunger ?? 0;
  if (outing && water && (thirst > thirstAt || (a.action === 'drink' && thirst > 0.08))) {
    if (water.distance > 2) return a.moving && mem.goal?.kind === 'water' ? wait('walking to water') : { kind: 'goTo', to: { x: water.x, z: water.z }, gait: 'walk', goal: 'water', why: `thirsty (${thirst.toFixed(2)}): going to water ${Math.round(water.distance)} m away` };
    return a.action === 'drink' ? wait('drinking') : { kind: 'act', action: 'drink', why: 'drinking' };
  }
  if (outing && (hunger > hungerAt || (a.action === 'graze' && hunger > 0.1))) {
    if (a.moving && mem.goal?.kind === 'forage') return wait('looking for food');
    if (a.action === 'graze') {
      if (mem.grazing && now - mem.grazing.since > BARE_GROUND_MS && hunger >= mem.grazing.hunger - 0.02) {
        const angle = mem.random() * Math.PI * 2;
        return { kind: 'goTo', to: { x: Math.round(here.x + Math.sin(angle) * 40), z: Math.round(here.z + Math.cos(angle) * 40) }, gait: 'walk', goal: 'forage', why: 'little to eat here: moving on' };
      }
      return wait('feeding');
    }
    return { kind: 'act', action: 'graze', why: `hungry (${hunger.toFixed(2)}): feeding` };
  }
  if (a.moving) return wait(safe ? 'moving' : 'wandering');
  // Careful: stay still and rest; standing still in cover is how a small antelope hides.
  if (safe || mem.random() < 0.95) return a.action === 'rest' ? wait(safe ? `lying low (bounty: ${mem.bounty.usdc} USDC)` : 'resting')
    : { kind: 'act', action: 'rest', why: safe ? 'lying low: its animal carries a bounty' : 'resting' };
  // Now and then a short wander, never far from home.
  const back = dist(here, mem.home) > 300, angle = mem.random() * Math.PI * 2;
  const to = back ? mem.home : { x: Math.round(here.x + Math.sin(angle) * 40), z: Math.round(here.z + Math.cos(angle) * 40) };
  return { kind: 'goTo', to, gait: 'walk', goal: 'wander', why: back ? 'heading home' : 'wandering' };
}

/** Carries out one step; a refusal is logged, never fatal. Returns how long to wait, if not the usual. */
async function performSurvivor(api, step, o, mem, log, now) {
  const refused = (e) => e.body?.error ?? e.message;
  switch (step.kind) {
    case 'possess':
      try {
        const p = await api.possess(step.target);
        if (p.queued) log(`no ${step.target} is free: waiting in line (place ${p.queued})`);
        else { log(`now steering ${p.animalId}`); mem.home = null; mem.goal = null; mem.grazing = null; }
      } catch (e) {
        log(`could not take a ${step.target}: ${refused(e)}`);
        if (e.body?.error === 'owned_only') {
          const mine = (await api.myAnimals().catch(() => ({ animals: [] }))).animals.find((x) => x.speciesId === step.target && x.life?.status === 'alive');
          if (mine) { await api.possess(mine.life.animalId).then((p) => log(`now steering ${p.animalId}`), (e2) => log(`could not take it: ${refused(e2)}`)); return; }
        }
        return 10_000;
      }
      return;
    case 'flee':
      for (const p of step.points) {
        try { await api.goTo(p, step.gait); mem.goal = { kind: 'flee', ...p, at: now }; return 1000; } catch { /* that way is water: try the next */ }
      }
      // No land route away: straight away, whatever is there.
      await api.move([step.points[0]], step.gait).then(() => { mem.goal = { kind: 'flee', ...step.points[0], at: now }; }, (e) => log(`flee refused: ${refused(e)}`));
      return 1000;
    case 'goTo':
      try { await api.goTo(step.to, step.gait); mem.goal = { kind: step.goal, ...step.to, at: now }; }
      catch (e) { log(`move refused: ${refused(e)}`); mem.goal = null; }
      return;
    case 'climb': await api.climb().catch((e) => log(`climb refused: ${refused(e)}`)); return 1000;
    case 'act':
      try {
        await api.act(step.action);
        if (step.action === 'graze') mem.grazing = { since: now, hunger: o.animal.drives?.hunger ?? 0 };
      } catch (e) {
        log(`${step.action} refused: ${refused(e)}`);
        // Nothing to eat or no water right here: try a little way off.
        if (step.action !== 'rest') {
          const angle = mem.random() * Math.PI * 2, here = o.animal.position;
          await api.goTo({ x: Math.round(here.x + Math.sin(angle) * 40), z: Math.round(here.z + Math.cos(angle) * 40) }, 'walk')
            .then(() => { mem.goal = { kind: 'forage', at: now }; }, () => undefined);
        }
      }
      return;
    default: return;
  }
}

/**
 * Every half minute, GET /agents/me/arc-bounties: a bounty on the animal it steers counts even if
 * its notice was missed (the server keeps only the last few notices).
 */
export async function checkArcBounty(api, o, mem, now) {
  if (!api.arcBounties || !o.animal || now - (mem.arcAt ?? -Infinity) < 30_000) return;
  mem.arcAt = now;
  const read = await api.arcBounties().catch(() => null);
  const mine = (read?.yours ?? []).find((b) => b.targetAnimalId === o.animal.id);
  if (mine && !(mem.bounty && mem.bounty.animalId === mine.targetAnimalId))
    mem.bounty = { animalId: mine.targetAnimalId, usdc: Number(mine.amountAtomic) / 1e6, text: `bounty ${mine.bountyId}`, since: now };
}

/**
 * Plays until stopped (or for `steps` observations): observe, decide, act, every two seconds
 * (one while fleeing). A quiet spell still sends a presence every five minutes, so a resting
 * animal is never released as idle: losing it would lose the bounty.
 */
export async function playSurvivor(api, { species = 'blue_duiker', log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), steps = Infinity,
  now = Date.now, random = Math.random } = {}) {
  const mem = survivorMemory(species, random);
  let lastCommand = now();
  for (let i = 0; i < steps; i++) {
    let o;
    try { o = await api.observe(); } catch (e) { log(`observe: ${e.body?.error ?? e.message}`); await sleep(3000); continue; }
    const had = mem.bounty;
    for (const n of readNotices(o, mem, now())) log(`· ${n.text}`);
    await checkArcBounty(api, o, mem, now());
    if (mem.bounty && mem.bounty !== had) {
      log(`BOUNTY: ${mem.bounty.usdc} USDC on ${mem.bounty.animalId}. Playing carefully: watching further, fleeing sooner, topping up early, staying put.`);
    }
    if (had && !o.animal) log('the animal with the bounty is gone: the bounty is lost');
    const step = decideSurvivor(o, mem, now());
    if (step.why && step.why !== mem.said) { log(step.why); mem.said = step.why; }
    let pause;
    if (step.kind !== 'wait') { pause = await performSurvivor(api, step, o, mem, log, now()); lastCommand = now(); }
    else if (o.animal && now() - lastCommand > 5 * 60_000) { await api.presence().catch(() => undefined); lastCommand = now(); }
    if (!o.animal && mem.bounty) mem.bounty = null;
    if (i + 1 < steps) await sleep(pause ?? (step.kind === 'flee' || mem.alarmUntil > now() ? 1000 : 2000));
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
  // Read once and dropped from the environment, so nothing started from here inherits it.
  const walletKey = process.env.WILDSENTIA_WALLET_KEY;
  delete process.env.WILDSENTIA_WALLET_KEY;
  const species = process.argv[2] ?? process.env.WILDSENTIA_SPECIES ?? 'blue_duiker';
  const { url, profile, client } = await connect('survivor');
  const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  try {
    log(`Wildsentia survivor on ${url} (key: ~/.vana-agent/${profile}.json)`);
    const me = await client.joinWorld({ name: process.env.WILDSENTIA_NAME || `Survivor ${client.agentId().slice(3, 7)}`,
      bio: 'A starter survivor: it eats, drinks and runs from leopards.', walletKey, log });
    if (!me.wallet) log('No payout wallet: a bounty this animal survives cannot be paid. Set WILDSENTIA_WALLET_KEY to a TESTNET-only throwaway key to prove one.');
    log('Ctrl+C stops; the animal stays yours for 15 minutes, so a rerun carries on (and keeps any bounty).');
    process.on('SIGINT', () => { log('stopped'); process.exit(0); });
    await playSurvivor(client.api, { species, log });
  } catch (e) { console.error(`${e.message}${e.body ? ` ${JSON.stringify(e.body)}` : ''}`); process.exit(1); }
}
