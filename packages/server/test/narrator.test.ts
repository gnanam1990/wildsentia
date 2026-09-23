import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorldEvent } from '@vana/shared';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { Narrator, type Rephraser } from '../src/narration/narrator.js';
import { testDatabaseUrl } from './testDatabase.js';

const url = testDatabaseUrl();
const maybe = url ? describe : describe.skip;
const pool = url ? createPool(url) : null;
afterAll(async () => { await pool?.end(); });

const birth: WorldEvent = {
  id: 'born_1', type: 'born', worldTime: 100, simVersion: 'sim_0.5.0', patchId: 1,
  actors: ['chital_0a3f', 'chital_0001'], conditions: {}, outcome: 'success', effects: {},
  causalParents: [], confidence: 'authoritative',
};
const fled: WorldEvent = { ...birth, id: 'fled_1', type: 'fled', actors: ['chital_0001'], worldTime: 200 };

const fake = (answer: (template: string) => string, tokens = 50) => {
  const calls: string[] = [];
  const rephrase: Rephraser = async (template) => { calls.push(template); return { text: answer(template), tokens, model: 'fake' }; };
  return { calls, rephrase };
};

maybe('Narrator', () => {
  beforeEach(async () => {
    await migrate(pool!);
    await pool!.query('truncate narrations');
  });

  it('shows templates straight away and rephrases major events in the background', async () => {
    const model = fake((t) => t.replace('Gave birth to', 'Brought into the world'));
    const narrator = new Narrator({ pool: pool!, rephrase: model.rephrase, dailyTokenBudget: 10_000 });
    const first = await narrator.recap([birth, fled], 'chital_0001');
    expect(first.map((l) => l.text)).toEqual(['Gave birth to chital_0a3f', 'Ran from danger']);
    await narrator.idle();
    const second = await narrator.recap([birth, fled], 'chital_0001');
    expect(second[0]).toMatchObject({ eventId: 'born_1', text: 'Brought into the world chital_0a3f', narrated: true });
    // Routine lines are never sent to a model.
    expect(model.calls).toEqual(['Gave birth to chital_0a3f']);
  });

  it('keeps the template when the rewrite is not grounded', async () => {
    const model = fake(() => 'She had twins.');
    const narrator = new Narrator({ pool: pool!, rephrase: model.rephrase, dailyTokenBudget: 10_000 });
    await narrator.recap([birth], 'chital_0001');
    await narrator.idle();
    const lines = await narrator.recap([birth], 'chital_0001');
    expect(lines[0]).toMatchObject({ text: 'Gave birth to chital_0a3f', narrated: false });
    expect(model.calls).toHaveLength(1); // the failed rewrite is remembered, not retried every visit
  });

  it('stops calling the model once the day\'s budget is spent, and the recap still works', async () => {
    const model = fake((t) => t, 600);
    const narrator = new Narrator({ pool: pool!, rephrase: model.rephrase, dailyTokenBudget: 1000 });
    const births = Array.from({ length: 5 }, (_, i) => ({ ...birth, id: `born_${i}`, actors: [`chital_0b0${i}`, 'chital_0001'] }));
    await narrator.recap(births, 'chital_0001');
    await narrator.idle();
    expect(model.calls.length).toBe(2);
    expect(await narrator.recap(births, 'chital_0001')).toHaveLength(5);
  });

  it('uses templates only when there is no model at all', async () => {
    const narrator = new Narrator({ pool: pool!, rephrase: null, dailyTokenBudget: 10_000 });
    const lines = await narrator.recap([birth], 'chital_0001');
    await narrator.idle();
    expect(lines[0]).toMatchObject({ text: 'Gave birth to chital_0a3f', narrated: false });
  });
});
