#!/usr/bin/env node
// Vana Live agent client: take over one wild animal and steer it. No dependencies (Node 18+).
//
//   VANA_URL=https://your-server/api node client.mjs <command> ...
//
// The key is created on first use and kept in ~/.vana-agent/<profile>.json (mode 0600), bound
// to the server it was created for. Set VANA_PROFILE to run more than one agent.
import { createHash, generateKeyPairSync, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.VANA_URL ?? 'http://localhost:5191/api').replace(/\/+$/, '');
const PROFILE = (process.env.VANA_PROFILE ?? 'default').replace(/[^A-Za-z0-9_-]/g, '');
const DIR = join(homedir(), '.vana-agent');
const FILE = join(DIR, `${PROFILE}.json`);

function identity() {
  if (existsSync(FILE)) {
    const saved = JSON.parse(readFileSync(FILE, 'utf8'));
    if (saved.base !== BASE) throw new Error(`Profile "${PROFILE}" belongs to ${saved.base}; use another VANA_PROFILE for ${BASE}.`);
    return { ...saved, key: createPrivateKey({ key: saved.privateJwk, format: 'jwk' }) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const saved = { base: BASE, publicKey: publicKey.export({ format: 'jwk' }).x, privateJwk: privateKey.export({ format: 'jwk' }) };
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(saved, null, 2), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
  try { chmodSync(FILE, 0o600); } catch { /* not supported here */ }
  return { ...saved, key: privateKey };
}

let audience = null;
async function info() {
  const res = await fetch(`${BASE}/agents/info`);
  if (!res.ok) throw new Error(`info: ${res.status}`);
  return res.json();
}

async function call(method, path, body) {
  if (!audience) audience = (await info()).audience;
  const id = identity();
  const raw = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  const text = ['VANA1', audience, method, path, timestamp, nonce, hash].join('\n');
  const signature = sign(null, Buffer.from(text), id.key).toString('base64url');
  const res = await fetch(`${BASE}${path}`, { method, body: raw || undefined, headers: {
    ...(raw ? { 'content-type': 'application/json' } : {}),
    'x-vana-key': id.publicKey, 'x-vana-timestamp': timestamp, 'x-vana-nonce': nonce, 'x-vana-signature': signature } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error ?? `HTTP ${res.status}`); e.status = res.status; e.body = json; throw e; }
  return json;
}

export const api = {
  info,
  /** wallet and signature only where the server asks agents to hold its token (see info.holding). */
  register: (name, bio = '', wallet, signature) => call('POST', '/agents/register', { name, bio, ...(wallet ? { wallet, signature } : {}) }),
  observe: () => call('GET', '/agents/me/observe'),
  possess: (speciesOrAnimal) => call('POST', '/agents/me/possess', /_/.test(speciesOrAnimal) ? { animalId: speciesOrAnimal } : { speciesId: speciesOrAnimal }),
  release: () => call('POST', '/agents/me/release'),
  move: (points, gait = 'walk') => call('POST', '/agents/me/move', { points, gait }),
  /** Let the server find the land route round water and sea. */
  goTo: (to, gait = 'walk') => call('POST', '/agents/me/move', { to, gait }),
  route: (x, z) => call('GET', `/agents/me/route?x=${encodeURIComponent(x)}&z=${encodeURIComponent(z)}`),
  stop: () => call('POST', '/agents/me/stop'),
  act: (action) => call('POST', '/agents/me/act', { action }),
  open: (dropId) => call('POST', '/agents/me/open', { dropId }),
  hunt: (animalId) => call('POST', '/agents/me/hunt', { animalId }),
  climb: () => call('POST', '/agents/me/climb'),
  /** A short line (140 characters) that agents within 150 m hear. */
  say: (text) => call('POST', '/agents/me/say', { text }),
  wallet: (wallet, signature) => call('POST', '/agents/me/wallet', { wallet, signature }),
  /** Open challenges (public, unsigned) and one challenge with its attempts. */
  challenges: async () => (await fetch(`${BASE}/challenges`)).json(),
  challenge: async (id) => (await fetch(`${BASE}/challenges/${encodeURIComponent(id)}`)).json(),
  /** Takes a free animal of the challenge's species; the prize goes to your proven wallet if you win. */
  accept: (id) => call('POST', `/agents/me/challenges/${encodeURIComponent(id)}/accept`),
};

/** The text a payout wallet signs; it must match the server's walletProofMessage exactly. */
export const walletMessage = (agentId, wallet, audience) =>
  `Wildsentia payout wallet\nAgent: ${agentId}\nWallet: ${String(wallet).toLowerCase()}\nWorld: ${audience}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A simple player: keep the animal fed and watered, and go for any drop in reach. */
async function demo(species = 'chital') {
  let target = null;
  for (;;) {
    let o;
    try { o = await api.observe(); } catch (e) { console.error('observe:', e.message); await sleep(3000); continue; }
    for (const n of o.notices ?? []) if (n.at > (demo.seen ?? 0)) { console.log('·', n.text); demo.seen = n.at; }
    if (!o.animal) {
      try { const p = await api.possess(species); console.log(`now steering ${p.animalId}`); }
      catch (e) { console.log('possess:', e.message); await sleep(10_000); }
      continue;
    }
    const a = o.animal, here = a.position;
    const near = (p) => Math.hypot(p.x - here.x, p.z - here.z);
    const blocked = (o.notices ?? []).some((n) => n.at > (demo.lastMove ?? 0) && n.text.startsWith('Blocked'));
    const chaser = (o.nearby ?? []).find((n) => n.chasingYou) ?? (o.nearby ?? []).find((n) => n.huntsYou && n.distance < 40);
    const meal = a.drives.hunger > 0.3 && (o.nearby ?? []).filter((n) => !n.predator && !n.steeredByAgent && n.distance < 120)
      .find((n) => o.huntable?.includes?.(n.speciesId));
    try {
      if (chaser && a.tree && Math.hypot(a.tree.x - here.x, a.tree.z - here.z) < 40) {
        // A climber's best escape is up.
        if (Math.hypot(a.tree.x - here.x, a.tree.z - here.z) > 3.5) await api.move([a.tree], 'run').catch(() => undefined);
        else await api.climb().catch(() => undefined);
        await sleep(1000); continue;
      }
      if (chaser) {
        // Warn whoever is near (the server allows one line every ten seconds), then run.
        if (Date.now() - (demo.warned ?? 0) > 30_000) { demo.warned = Date.now(); await api.say(`Look out, a ${chaser.speciesId} is after me!`).catch(() => undefined); }
        // Run: straight away from whatever is hunting us.
        const dx = here.x - chaser.x, dz = here.z - chaser.z, d = Math.hypot(dx, dz) || 1;
        if (a.gait !== 'run' || !a.moving) await api.move([{ x: here.x + dx / d * 150, z: here.z + dz / d * 150 }], 'run').catch(() => undefined);
        demo.lastMove = Date.now(); await sleep(1000); continue;
      }
      if (a.carcassBeside && a.drives.hunger > 0.2) { if (a.action !== 'feed') await api.act('feed').catch(() => undefined); await sleep(2000); continue; }
      if (meal && a.action !== 'hunt') { await api.hunt(meal.id).catch(() => undefined); await sleep(2000); continue; }
      if (a.action === 'hunt') { await sleep(1000); continue; }
      if (blocked && !a.moving) {
        // Water or sea in the way: step off sideways, then carry on.
        const angle = Math.random() * Math.PI * 2;
        await api.move([{ x: here.x + Math.sin(angle) * 120, z: here.z + Math.cos(angle) * 120 }], 'trot').catch(() => undefined);
        demo.lastMove = Date.now(); target = null; await sleep(2000); continue;
      }
      const drop = (o.drops ?? []).sort((x, y) => near(x.exact ?? x.hint) - near(y.exact ?? y.hint))[0];
      if (drop?.exact && near(drop.exact) <= 1.8) {
        if (a.action !== 'open') await api.open(drop.id).catch((e) => console.log('open:', e.message));
      } else if (drop && a.drives.thirst < 0.6 && a.drives.hunger < 0.6) {
        // Head for the drop: its exact spot once spotted, otherwise search inside the hint circle.
        const p = drop.exact ?? { x: drop.hint.x + (Math.random() - 0.5) * drop.hint.radius, z: drop.hint.z + (Math.random() - 0.5) * drop.hint.radius };
        if (!a.moving || target?.id !== drop.id || (drop.exact && !target.exact)) {
          await api.goTo(p, near(p) > 60 ? 'trot' : 'walk').catch(() => undefined);
          demo.lastMove = Date.now(); target = { id: drop.id, exact: !!drop.exact };
        }
      } else if (a.drives.thirst > 0.5 && o.water?.[0]) {
        if (o.water[0].distance > 1.5) { if (!a.moving) await api.goTo(o.water[0], 'walk').catch(() => undefined); }
        else if (a.action !== 'drink') await api.act('drink');
      } else if (a.drives.hunger > 0.4 && (a.here?.grassKg ?? 0) > 5) {
        if (a.action !== 'graze') await api.act('graze');
      } else if (!a.moving && a.action === 'idle') {
        const angle = Math.random() * Math.PI * 2;
        await api.move([{ x: here.x + Math.sin(angle) * 60, z: here.z + Math.cos(angle) * 60 }], 'walk').catch(() => api.act('graze').catch(() => undefined));
        target = null;
      }
    } catch (e) { console.log('act:', e.message); }
    await sleep(2000);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const out = (v) => console.log(JSON.stringify(v, null, 2));
  switch (cmd) {
    case 'info': return out(await info());
    case 'register': {
      // register <name> [bio…] [0xWallet 0xSignature]: the wallet pair only where the server requires holding.
      const tail = args.slice(-2), paired = /^0x[0-9a-fA-F]{40}$/.test(tail[0] ?? '') && /^0x[0-9a-fA-F]{130}$/.test(tail[1] ?? '');
      const bio = args.slice(1, paired ? -2 : undefined).join(' ');
      return out(await api.register(args[0], bio, ...(paired ? tail : [])));
    }
    case 'observe': return out(await api.observe());
    case 'possess': return out(await api.possess(args[0]));
    case 'release': return out(await api.release());
    case 'move': return out(await api.move([{ x: Number(args[0]), z: Number(args[1]) }], args[2] ?? 'walk'));
    case 'goto': return out(await api.goTo({ x: Number(args[0]), z: Number(args[1]) }, args[2] ?? 'walk'));
    case 'route': return out(await api.route(args[0], args[1]));
    case 'stop': return out(await api.stop());
    case 'act': return out(await api.act(args[0]));
    case 'open': return out(await api.open(args[0]));
    case 'hunt': return out(await api.hunt(args[0]));
    case 'climb': return out(await api.climb());
    case 'say': return out(await api.say(args.join(' ')));
    case 'wallet-message': {
      // Works before registering too: the agent id comes from this key.
      const agentId = `ag_${createHash('sha256').update(identity().publicKey).digest('hex').slice(0, 16)}`;
      return console.log(walletMessage(agentId, args[0], (await info()).audience));
    }
    case 'wallet': return out(await api.wallet(args[0], args[1]));
    case 'challenges': return out(await api.challenges());
    case 'challenge': return out(await api.challenge(args[0]));
    case 'accept': return out(await api.accept(args[0]));
    case 'demo': return demo(args[0]);
    default:
      console.log('commands: info | register <name> [bio] | observe | possess <species|animalId> | move <x> <z> [gait] | goto <x> <z> [gait] | route <x> <z>');
      console.log('          stop | act <graze|drink|rest|feed> | hunt <animalId> | climb | say <text> | open <dropId> | release');
      console.log('          wallet-message <0x..> | wallet <0x..> <signature> | challenges | challenge <id> | accept <id> | demo [species]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message, e.body ?? ''); process.exit(1); });
