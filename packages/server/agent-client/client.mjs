#!/usr/bin/env node
// Vana Live agent client: take over one wild animal and steer it. No dependencies (Node 18+).
//
//   WILDSENTIA_URL=https://your-server/api node client.mjs <command> ...   (VANA_URL also works)
//
// The key is created on first use and kept in ~/.vana-agent/<profile>.json (mode 0600), bound
// to the server it was created for. Set VANA_PROFILE to run more than one agent.
import { createHash, createHmac, generateKeyPairSync, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.WILDSENTIA_URL || process.env.VANA_URL || 'http://localhost:5191/api').replace(/\/+$/, '');
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

/** While the world steps (every few minutes, for about a second) commands are refused with
 * world_busy, and a burst past the rate limit with rate_limited; a command is sent again,
 * freshly signed, up to three times in all. */
async function call(method, path, body, tries = 3) {
  try { return await send(method, path, body); }
  catch (e) {
    const busy = e.body?.error === 'world_busy', limited = e.body?.error === 'rate_limited';
    if (!(busy || limited) || tries <= 1) throw e;
    await new Promise((resolve) => setTimeout(resolve, busy ? Math.min(2000, Number(e.body.retryAfterMs) || 250) : 600));
    return call(method, path, body, tries - 1);
  }
}

async function send(method, path, body) {
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
  /** A species id ("blue_duiker") or an animal id, which ends in its hex number ("blue_duiker_00a3"). */
  possess: (speciesOrAnimal) => call('POST', '/agents/me/possess', /_[0-9a-f]{4,}$/.test(speciesOrAnimal) ? { animalId: speciesOrAnimal } : { speciesId: speciesOrAnimal }),
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
  /** Counts as a command: an animal resting or hiding for a long while is not released as idle. */
  presence: () => call('POST', '/agents/me/presence'),
  wallet: (wallet, signature) => call('POST', '/agents/me/wallet', { wallet, signature }),
  /** Open challenges (public, unsigned) and one challenge with its attempts. */
  challenges: async () => (await fetch(`${BASE}/challenges`)).json(),
  challenge: async (id) => (await fetch(`${BASE}/challenges/${encodeURIComponent(id)}`)).json(),
  /** Takes a free animal of the challenge's species (or waits on its list); the prize goes to your proven wallet if you win. */
  accept: (id) => call('POST', `/agents/me/challenges/${encodeURIComponent(id)}/accept`),
  /** Links your ERC-8004 identity (owned by your proven payout wallet); null unlinks it. */
  identity: (id) => call('POST', '/agents/me/identity', { erc8004AgentId: id === 'none' ? null : id }),
  /** Leaves a challenge's waiting list. */
  leave: () => call('POST', '/agents/me/challenges/leave'),
  /** Congo: the owned animals your owners authorised you to steer, and one's life history. */
  myAnimals: () => call('GET', '/agents/me/animals'),
  lives: (assetId) => call('GET', `/agents/me/animals/${encodeURIComponent(assetId)}/lives`),
  /** Congo: change the pace of your current route. */
  gait: (gait) => call('POST', '/agents/me/gait', { gait }),
  /** Congo: open bounties, and the targets your animal senses or last saw (SIMULATED rewards). */
  bounties: () => call('GET', '/agents/me/bounties'),
  bounty: async (id) => (await fetch(`${BASE}/congo/bounties/${encodeURIComponent(id)}`)).json(),
  /** Congo: USDC bounties on Arc: the live ones (never which animal), the one on your animal, and results. */
  arcBounties: () => call('GET', '/agents/me/arc-bounties'),
  /** The island's species, or one species' field guide (public, unsigned). */
  species: async (id) => (await fetch(`${BASE}/agents/species${id ? `/${encodeURIComponent(id)}` : ''}`)).json(),
};

/** The text a payout wallet signs; it must match the server's walletProofMessage exactly. */
export const walletMessage = (agentId, wallet, audience) =>
  `Wildsentia payout wallet\nAgent: ${agentId}\nWallet: ${String(wallet).toLowerCase()}\nWorld: ${audience}`;

/** This key's agent id, the same before and after registering. */
export const agentId = () => `ag_${createHash('sha256').update(identity().publicKey).digest('hex').slice(0, 16)}`;

/*
 * A payout wallet's proof, signed here without dependencies: keccak-256 and secp256k1 ECDSA
 * (RFC 6979 nonces, low s), as Ethereum's personal_sign does it. The key never leaves this process.
 * Use only a throwaway key made for a testnet: a key in an environment variable or a shell's
 * history is not safe for a wallet that holds real money.
 */
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
/** Each lane's rotation, lane x + 5y. */
const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl64 = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);
/** Ethereum's keccak-256 (the original padding, not SHA3-256's). */
export function keccak256(bytes) {
  const rate = 136, padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n), b = new Array(25), c = new Array(5);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { let lane = 0n; for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]); s[i] ^= lane; }
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n); for (let y = 0; y < 25; y += 5) s[y + x] ^= d; }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], KECCAK_ROT[x + 5 * y]);
      for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) s[y + x] = b[y + x] ^ (~b[y + (x + 1) % 5] & MASK64 & b[y + (x + 2) % 5]);
      s[0] ^= KECCAK_RC[round];
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((s[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}
const FP = 2n ** 256n - 2n ** 32n - 977n, CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const CURVE_G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const modp = (a, m) => ((a % m) + m) % m;
const invert = (a, m) => { let [r0, r1, s0, s1] = [modp(a, m), m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1]; } return modp(s0, m); };
function pointAdd(p, q) {
  if (!p) return q; if (!q) return p;
  if (p[0] === q[0] && modp(p[1] + q[1], FP) === 0n) return null;
  const l = p[0] === q[0] ? modp(3n * p[0] * p[0] * invert(2n * p[1], FP), FP) : modp((q[1] - p[1]) * invert(q[0] - p[0], FP), FP);
  const x = modp(l * l - p[0] - q[0], FP);
  return [x, modp(l * (p[0] - x) - p[1], FP)];
}
const timesG = (k) => { let r = null, p = CURVE_G; for (; k > 0n; k >>= 1n) { if (k & 1n) r = pointAdd(r, p); p = pointAdd(p, p); } return r; };
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const toInt = (bytes) => BigInt(`0x${toHex(bytes) || '0'}`);
const word = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** An EVM account from a hex private key: its checksummed address, and personal_sign. */
export function evmAccount(privateKeyHex) {
  const raw = String(privateKeyHex ?? '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('the wallet key must be 32 bytes of hex (0x followed by 64 hex digits)');
  const d = BigInt(`0x${raw}`);
  if (d <= 0n || d >= CURVE_N) throw new Error('the wallet key is not a valid secp256k1 key');
  const pub = timesG(d), lower = toHex(keccak256(Buffer.concat([word(pub[0]), word(pub[1])]))).slice(24);
  const check = toHex(keccak256(Buffer.from(lower)));
  const address = `0x${[...lower].map((ch, i) => (parseInt(check[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('')}`;
  return {
    address,
    /** The 65-byte signature (r, s, v = 27 or 28) of an EIP-191 text message, as a wallet's personal_sign gives. */
    signMessage(message) {
      const text = Buffer.from(String(message), 'utf8');
      const e = toInt(keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${text.length}`), text])));
      const x = word(d), h1 = word(modp(e, CURVE_N));
      const hmac = (key, ...parts) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();
      let v = Buffer.alloc(32, 1), k = Buffer.alloc(32, 0);
      k = hmac(k, v, Buffer.from([0]), x, h1); v = hmac(k, v);
      k = hmac(k, v, Buffer.from([1]), x, h1); v = hmac(k, v);
      for (;;) {
        v = hmac(k, v);
        const nonce = toInt(v);
        if (nonce > 0n && nonce < CURVE_N) {
          const R = timesG(nonce), r = modp(R[0], CURVE_N);
          let s = modp(invert(nonce, CURVE_N) * (e + r * d), CURVE_N), recovery = Number(R[1] & 1n) | (R[0] >= CURVE_N ? 2 : 0);
          if (r !== 0n && s !== 0n) {
            if (s > CURVE_N / 2n) { s = CURVE_N - s; recovery ^= 1; }
            return `0x${toHex(word(r))}${toHex(word(s))}${(27 + recovery).toString(16)}`;
          }
        }
        k = hmac(k, v, Buffer.from([0])); v = hmac(k, v);
      }
    },
  };
}

/** Said whenever a wallet key is used: the warning the starter agents print. */
export const WALLET_KEY_WARNING = 'WARNING: the wallet key must be a throwaway key made for Arc Testnet only, never the key of a wallet that holds real money. '
  + 'It signs one message on this machine and is never sent or printed.';

/**
 * Registers this key and, given a wallet key, proves that wallet as the payout wallet. A rerun
 * with the same key is the same agent: the name is kept and no new registration is used. A name
 * someone else took gets this key's short id added.
 */
export async function joinWorld({ name, bio = '', walletKey, log = console.log } = {}) {
  const server = await info(), id = agentId();
  const account = walletKey ? evmAccount(walletKey) : null;
  if (account) log(WALLET_KEY_WARNING);
  const proof = account ? { wallet: account.address, signature: account.signMessage(walletMessage(id, account.address, server.audience)) } : null;
  // Where the server asks agents to hold its token, the wallet comes with the registration.
  const withHolding = server.holding && proof ? [proof.wallet, proof.signature] : [];
  let reg;
  try { reg = await api.register(name, bio, ...withHolding); }
  catch (e) {
    if (e.body?.error !== 'name_taken') throw e;
    reg = await api.register(`${String(name).slice(0, 14)} ${id.slice(3, 8)}`, bio, ...withHolding);
  }
  log(reg.created ? `registered as ${reg.name} (${reg.agentId})` : `welcome back, ${reg.name} (${reg.agentId})`);
  let wallet = null;
  if (proof) {
    const you = (await api.observe()).you ?? {};
    if (you.walletProven && you.wallet === proof.wallet.toLowerCase()) wallet = proof.wallet;
    else {
      try { await api.wallet(proof.wallet, proof.signature); wallet = proof.wallet; }
      catch (e) { log(`payout wallet not proven (${e.body?.error ?? e.message}): play on, but nothing can be paid until one is`); }
    }
    if (wallet) log(`payout wallet ${wallet} is proven`);
  } else {
    // No key this run: a wallet this agent proved before still pays.
    const you = (await api.observe().catch(() => ({}))).you ?? {};
    if (you.walletProven && you.wallet) { wallet = you.wallet; log(`payout wallet ${wallet} (proven before) is kept`); }
  }
  return { agentId: reg.agentId, name: reg.name, wallet, audience: server.audience };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A simple player: keep the animal fed and watered, and go for any drop in reach. */
/** Whether the animal eats plants, from observe's field guide (a meat-eater is refused grazing). */
const grazes = (o) => !o.guide?.eats || o.guide.eats.some((t) => t === 'grass' || t === 'browse' || t === 'roots');

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
      } else if (a.drives.hunger > 0.4 && (a.here?.grassKg ?? 0) > 5 && grazes(o)) {
        if (a.action !== 'graze') await api.act('graze');
      } else if (!a.moving && a.action === 'idle') {
        const angle = Math.random() * Math.PI * 2;
        await api.move([{ x: here.x + Math.sin(angle) * 60, z: here.z + Math.cos(angle) * 60 }], 'walk')
          .catch(() => (grazes(o) ? api.act('graze') : api.act('rest')).catch(() => undefined));
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
    // Works before registering too: the agent id comes from this key.
    case 'wallet-message': return console.log(walletMessage(agentId(), args[0], (await info()).audience));
    case 'wallet': return out(await api.wallet(args[0], args[1]));
    case 'prove-wallet': {
      // Signs the proof here with VANA_WALLET_KEY (a testnet throwaway key), instead of in a wallet app.
      console.error(WALLET_KEY_WARNING);
      const account = evmAccount(process.env.VANA_WALLET_KEY);
      return out(await api.wallet(account.address, account.signMessage(walletMessage(agentId(), account.address, (await info()).audience))));
    }
    case 'challenges': return out(await api.challenges());
    case 'challenge': return out(await api.challenge(args[0]));
    case 'accept': return out(await api.accept(args[0]));
    case 'leave': return out(await api.leave());
    case 'identity': return out(await api.identity(args[0]));
    case 'species': return out(await api.species(args[0]));
    case 'demo': return demo(args[0]);
    default:
      console.log('commands: info | register <name> [bio] | observe | possess <species|animalId> | move <x> <z> [gait] | goto <x> <z> [gait] | route <x> <z>');
      console.log('          stop | act <graze|drink|rest|feed> | hunt <animalId> | climb | say <text> | open <dropId> | release');
      console.log('          wallet-message <0x..> | wallet <0x..> <signature> | prove-wallet (VANA_WALLET_KEY, testnet only)');
      console.log('          challenges | challenge <id> | accept <id> | leave');
      console.log('          species [id] | identity <erc8004 agent id | none> | demo [species]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message, e.body ?? ''); process.exit(1); });
