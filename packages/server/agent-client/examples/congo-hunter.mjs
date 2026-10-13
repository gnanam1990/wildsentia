#!/usr/bin/env node
// An example Wildsentia Congo agent, verified end to end (spec §7): it talks to the local MCP
// bridge (../mcp.mjs) exactly as an MCP client would, takes the leopard its owner authorised,
// reads the bounty board, ranges until its leopard senses a bounty target (or reaches where one
// was last seen), closes in and hunts it. Rewards are SIMULATED.
//
//   VANA_URL=https://your-server/api VANA_PROFILE=hunter node congo-hunter.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

/** A minimal MCP client over a child process's stdio. */
export function mcpClient(env = process.env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
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

/**
 * One hunt: returns what happened. `log` receives a line per step; `tick` waits between steps
 * (the world moves in real time).
 */
export async function hunt(mcp, { log = console.log, tick = () => wait(2000), maxSteps = 120 } = {}) {
  const mine = await mcp.call('get_my_animals');
  const leopard = mine.animals.find((a) => a.speciesId === 'african_leopard' && a.life?.status === 'alive');
  if (!leopard) return { ok: false, reason: 'no_leopard_authorised' };
  await mcp.call('take_control', { animalId: leopard.life.animalId });
  log(`steering ${leopard.life.animalId}`);
  for (let step = 0; step < maxSteps; step++) {
    const seen = await mcp.call('observe_animal'), board = await mcp.call('get_nearby_bounties');
    if (!seen.animal) return { ok: false, reason: 'lost_control' };
    const target = seen.nearby.find((a) => a.bounty);
    if (target) {
      log(`sensed bounty target ${target.id} (${target.sense}) at ${target.distance} m`);
      if (target.distance > 12) await mcp.call('move_to', { x: target.x, z: target.z, gait: target.distance > 60 ? 'trot' : 'run' });
      else {
        const result = await mcp.call('hunt', { animalId: target.id }).catch((e) => e.refusal);
        log(`hunt: ${JSON.stringify(result)}`);
        if (result?.ok !== false) return { ok: true, target: target.id, bountyId: target.bounty.bountyId };
      }
    } else if (board.lastSeen?.length) {
      const last = board.lastSeen[0];
      log(`heading for where bounty ${last.bountyId} was last seen`);
      await mcp.call('move_to', { x: last.x, z: last.z, gait: 'trot' });
    } else {
      // Range: a loop out from where it stands, so its senses sweep new ground.
      const me = seen.animal.position, a = step * 0.9, r = 80 + step * 20;
      await mcp.call('move_to', { x: me.x + Math.cos(a) * r, z: me.z + Math.sin(a) * r, gait: 'walk' }).catch(() => undefined);
    }
    await tick();
  }
  return { ok: false, reason: 'not_found' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mcp = mcpClient();
  await mcp.start();
  try { console.log(JSON.stringify(await hunt(mcp))); } finally { mcp.close(); }
}
