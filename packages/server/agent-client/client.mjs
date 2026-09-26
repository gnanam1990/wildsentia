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
  register: (name, bio = '') => call('POST', '/agents/register', { name, bio }),
  observe: () => call('GET', '/agents/me/observe'),
  possess: (speciesOrAnimal) => call('POST', '/agents/me/possess', /_/.test(speciesOrAnimal) ? { animalId: speciesOrAnimal } : { speciesId: speciesOrAnimal }),
  release: () => call('POST', '/agents/me/release'),
  move: (points, gait = 'walk') => call('POST', '/agents/me/move', { points, gait }),
  stop: () => call('POST', '/agents/me/stop'),
  act: (action) => call('POST', '/agents/me/act', { action }),
  open: (dropId) => call('POST', '/agents/me/open', { dropId }),
  wallet: (wallet, signature) => call('POST', '/agents/me/wallet', { wallet, signature }),
};

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
    try {
      const drop = (o.drops ?? []).sort((x, y) => near(x.exact ?? x.hint) - near(y.exact ?? y.hint))[0];
      if (drop?.exact && near(drop.exact) <= 1.8) {
        if (a.action !== 'open') await api.open(drop.id).catch((e) => console.log('open:', e.message));
      } else if (drop && near(drop.exact ?? drop.hint) < 1500) {
        const p = drop.exact ?? { x: drop.hint.x + (Math.random() - 0.5) * drop.hint.radius, z: drop.hint.z + (Math.random() - 0.5) * drop.hint.radius };
        if (!a.moving || target?.id !== drop.id) { await api.move([p], 'trot').catch(() => undefined); target = { id: drop.id }; }
      } else if (a.drives.thirst > 0.5 && o.water?.[0]) {
        if (o.water[0].distance > 1.5) { if (!a.moving) await api.move([o.water[0]], 'walk').catch(() => undefined); }
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
    case 'register': return out(await api.register(args[0], args.slice(1).join(' ')));
    case 'observe': return out(await api.observe());
    case 'possess': return out(await api.possess(args[0]));
    case 'release': return out(await api.release());
    case 'move': return out(await api.move([{ x: Number(args[0]), z: Number(args[1]) }], args[2] ?? 'walk'));
    case 'stop': return out(await api.stop());
    case 'act': return out(await api.act(args[0]));
    case 'open': return out(await api.open(args[0]));
    case 'wallet-message': {
      const o = await api.observe();
      return console.log(`Vana payout wallet\nAgent: ${o.you.agentId}\nWallet: ${String(args[0]).toLowerCase()}\nWorld: ${(await info()).audience}`);
    }
    case 'wallet': return out(await api.wallet(args[0], args[1]));
    case 'demo': return demo(args[0]);
    default:
      console.log('commands: info | register <name> [bio] | observe | possess <species|animalId> | move <x> <z> [walk|trot|run]');
      console.log('          stop | act <graze|drink|rest> | open <dropId> | release | wallet-message <0x..> | wallet <0x..> <signature> | demo [species]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message, e.body ?? ''); process.exit(1); });
