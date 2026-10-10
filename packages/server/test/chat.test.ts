import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createWorld } from '@vana/sim';
import { cleanChat, CHAT_GAP_MS, HEARD_FOR_MS, SHOWN_FOR_MS } from '../src/live/chat.js';
import { LiveLayer } from '../src/live/liveLayer.js';
import { worldPort } from '../src/live/worldPort.js';

describe('what an animal may say', () => {
  it('keeps a plain short line, with hidden characters and runs of space removed', () => {
    expect(cleanChat('  Water   by the​ fig\ttree!  ')).toEqual({ ok: true, text: 'Water by the fig tree!' });
    // A right-to-left override cannot disguise the text people see.
    expect(cleanChat('safe ‮etis‬ here')).toEqual({ ok: true, text: 'safe etis here' });
    const long = 'grass '.repeat(24).slice(0, 140);
    expect(cleanChat(long)).toMatchObject({ ok: true });
    expect(cleanChat(`${long}!`)).toEqual({ ok: false, error: 'bad_text' });
    // One unbroken run that long is not a sentence.
    expect(cleanChat('x'.repeat(40))).toEqual({ ok: false, error: 'no_addresses_or_keys' });
    expect(cleanChat(' ​ ')).toEqual({ ok: false, error: 'bad_text' });
    expect(cleanChat(42)).toEqual({ ok: false, error: 'bad_text' });
  });

  it('refuses links, even written in full-width letters, and anything like an address or a key', () => {
    for (const t of ['see https://evil.example', 'go to www.claim-usdc', 'free usdc at airdrop.xyz', 'ｗｗｗ．ｅｖｉｌ．ｃｏｍ', 'ipfs://abc'])
      expect(cleanChat(t), t).toEqual({ ok: false, error: 'no_links' });
    for (const t of [`send to 0x${'ab'.repeat(20)}`, 'paste your key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', 'MC4CAQAwBQYDK2VwBCIEIFf1ixrBkDTwNQqH6h7'])
      expect(cleanChat(t), t).toEqual({ ok: false, error: 'no_addresses_or_keys' });
  });

  it('refuses a link hidden with invisible characters, look-alike letters or other full stops', () => {
    for (const t of [
      'visit evil\u200b.com',        // A zero-width space before the dot.
      'claim at airdrop\u2060.xyz',  // A word joiner.
      'visit \u0435vil.\u0441\u043em',  // Cyrillic е, с and о.
      'see g\u03bf\u03bfgle.com',     // Greek omicrons.
      'go to evil\u3002com',         // An ideographic full stop, which browsers read as a dot.
      'go to evil\uff61com',         // Its half-width form.
    ]) expect(cleanChat(t), t).toEqual({ ok: false, error: 'no_links' });
    // Words in other scripts are still fine.
    expect(cleanChat('\u041f\u0440\u0438\u0432\u0435\u0442, \u03b3\u03b5\u03b9\u03b1 \u03c3\u03bf\u03c5')).toMatchObject({ ok: true });
  });
});

describe('chat between agents', () => {
  const speciesDir = fileURLToPath(new URL('../../../config/species', import.meta.url));
  function setup() {
    const world = createWorld({ seed: 3, speciesDir, terrainProfile: 'island_v1', initialAgents: { sambar: 10, chital: 10 }, minPopulation: {} });
    let now = 1_000_000;
    const live = new LiveLayer(worldPort(() => world, () => 'w1'), null, () => now);
    for (const [id, name, species] of [['ag_a', 'Sora', 'chital'], ['ag_b', 'Kavya', 'chital'], ['ag_c', 'Ravi', 'sambar']] as const)
      expect(live.possess(id, name, { speciesId: species }).ok).toBe(true);
    const place = (id: string, x: number, z: number) => { const a = live.avatars.get(id)!; a.x = x; a.z = z; };
    return { live, place, advance: (ms: number) => { now += ms; } };
  }

  it('is heard only within 150 m, never by the speaker, and one line per ten seconds', () => {
    const { live, place, advance } = setup();
    place('ag_a', 1000, 1000); place('ag_b', 1100, 1000); place('ag_c', 1300, 1000);
    expect(live.say('ag_a', 'Tiger at the river!')).toBeNull();
    expect(live.say('ag_a', 'again')).toBe('too_soon');
    expect(live.heard('ag_b')).toEqual([{ from: 'Sora', agentId: 'ag_a', animalId: live.avatars.get('ag_a')!.animalId,
      text: 'Tiger at the river!', secondsAgo: 0, distance: 100 }]);
    expect(live.heard('ag_c')).toEqual([]);
    expect(live.heard('ag_a')).toEqual([]);
    advance(CHAT_GAP_MS);
    expect(live.say('ag_a', 'again')).toBeNull();
    expect(live.say('nobody', 'hi')).toBe('not_possessing');
    expect(live.say('ag_b', 'hi', true)).toBe('muted');
    advance(HEARD_FOR_MS + 1);
    expect(live.heard('ag_b')).toEqual([]);
  });

  it('shows a line over the animal for a few seconds, and takes it back when the agent is muted', () => {
    const { live, advance } = setup();
    live.say('ag_a', 'Hello forest');
    const said = () => (live.publicState().avatars as Array<{ agentId: string; said?: string }>).find((a) => a.agentId === 'ag_a')!.said;
    expect(said()).toBe('Hello forest');
    advance(SHOWN_FOR_MS + 1);
    expect(said()).toBeUndefined();
    advance(CHAT_GAP_MS);
    live.say('ag_a', 'Second line');
    live.forgetSaid('ag_a');
    expect(said()).toBeUndefined();
    expect(live.heard('ag_b')).toEqual([]);
  });
});
