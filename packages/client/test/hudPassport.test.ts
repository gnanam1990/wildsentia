import { describe, expect, it } from 'vitest';
import { Hud, type HudElements, type Passport } from '../src/hud.js';
import { WorldStore } from '../src/protocol.js';

const elements = (): HudElements => ({
  clock: { innerHTML: '' } as HTMLElement,
  season: { innerHTML: '' } as HTMLElement,
  population: { innerHTML: '' } as HTMLElement,
  passport: { innerHTML: '' } as HTMLElement,
  feed: { innerHTML: '' } as HTMLElement,
  notice: { textContent: '' } as HTMLElement,
});

const passport = (): Passport => ({
  id: 'boar_01', speciesId: 'boar', displayName: 'Wild boar', sex: 'female', ageDays: 90,
  lifeStage: 'juvenile', generation: 2, alive: true, massKg: 10, thought: null,
  lineage: { mother: { id: 'boar_mother', alive: true }, father: null, offspring: [] },
  skills: [], death: null, timeline: [],
});

const setup = () => {
  const store = new WorldStore(), nodes = elements(), hud = new Hud(nodes, store);
  store.apply({ type: 'animals', animals: [{ id: 'boar_01', speciesId: 'boar', patchId: 7,
    state: 'seeking_water', currentGoal: 'find_water', drives: { hunger: .2, thirst: .4, fatigue: .1, fear: 0 } }] });
  hud.passport = passport();
  return { store, nodes, hud };
};

describe('compact observer passport', () => {
  it('retains played activity, escaped AI attribution and current clock in the tabbed inspector', () => {
    const { nodes, hud } = setup();
    hud.liveActivity = () => ({ state: 'running_away', goal: 'find_shelter', agent: '<script>pilot</script>' });
    let played: number | null = 3600;
    hud.clockTime = () => played;
    hud.render('boar_01');
    expect(nodes.clock.innerHTML).toContain('1 am');
    expect(nodes.passport.innerHTML).toContain('Running away');
    expect(nodes.passport.innerHTML).toContain('Find shelter');
    expect(nodes.passport.innerHTML).toContain('Steered by &#60;script&#62;pilot&#60;/script&#62; (AI agent)');
    expect(nodes.passport.innerHTML).not.toContain('<script>');
    expect(nodes.passport.innerHTML).toContain('data-passport-tab="record"');
    played = null; hud.render('boar_01');
    expect(nodes.clock.innerHTML).toContain('not reported by the simulation');
    expect(nodes.clock.innerHTML).not.toContain('1 am');
  });

  it('does not rebuild the tabbed inspector on unchanged one-second refreshes', () => {
    const { nodes, hud } = setup();
    let writes = 0, html = '';
    Object.defineProperty(nodes.passport, 'innerHTML', { get: () => html, set: (value: string) => { html = value; writes++; } });
    hud.render('boar_01'); hud.render('boar_01'); hud.render('boar_01');
    expect(writes).toBe(1);
    hud.liveActivity = () => ({ state: 'resting', goal: 'rest' });
    hud.render('boar_01');
    expect(writes).toBe(2);
  });
  it('sends factual population totals and an explicit unknown state to a custom counter', () => {
    const { nodes, hud, store } = setup();
    const states: Array<{ total: number | null; listHtml: string }> = [];
    nodes.renderPopulation = (total, listHtml) => { states.push({ total, listHtml }); };
    hud.render(null);
    store.apply({ type: 'world', worldTime: 0, population: { boar: 3, '<species>': 2 } });
    hud.render(null);
    store.world = null;
    hud.render(null);
    expect(states).toEqual([
      { total: null, listHtml: '' },
      { total: 5, listHtml: '<span>wild boar <b>3</b></span><span>&#60;species&#62; <b>2</b></span>' },
      { total: null, listHtml: '' },
    ]);
  });

  it('restores unchanged population data after an unavailable world without a custom counter', () => {
    const { nodes, hud, store } = setup();
    const world = { type: 'world', worldTime: 0, population: { boar: 3 } };
    store.apply(world); hud.render(null);
    expect(nodes.population.innerHTML).toContain('3 animals');
    store.world = null; hud.render(null);
    expect(nodes.population.innerHTML).toContain('not reported by the simulation');
    store.apply(world); hud.render(null);
    expect(nodes.population.innerHTML).toContain('3 animals');
  });

  it('keeps a compact overview and moves identity provenance into the Record tab', () => {
    const { nodes, hud } = setup();
    hud.render('boar_01');
    const html = nodes.passport.innerHTML;
    expect(html).toContain('<h2>Wild boar</h2>');
    expect(html).toContain('Female &middot; 90 days &middot; Juvenile');
    expect(html).toContain('class="vitals"');
    expect(html).toContain('class="subject-activity"');
    expect(html).toContain('Seeking water');
    expect(html).toContain('Find water');
    const heading = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(heading).not.toContain('boar_01');
    const record = html.slice(html.indexOf('id="passport-panel-record"'));
    expect(record).toContain('<code>boar_01</code>');
    expect(record).toContain('<dt>Generation</dt><dd>2</dd>');
    expect(record).toContain('within-patch placement is approximate');
    expect(html).toContain('data-follow="boar_mother"');
    for (const action of ['history', 'replay', 'share']) expect(html).toContain(`data-${action}="boar_01"`);
  });

  it('connects three accessible tabs to their panels and keeps all actions outside the panels', () => {
    const { nodes, hud } = setup();
    hud.render('boar_01');
    const html = nodes.passport.innerHTML;
    expect(html).toContain('role="tablist" aria-label="Animal information"');
    for (const tab of ['overview', 'life', 'record']) {
      expect(html).toContain(`role="tab" id="passport-tab-${tab}" aria-controls="passport-panel-${tab}"`);
      expect(html).toContain(`role="tabpanel" id="passport-panel-${tab}" aria-labelledby="passport-tab-${tab}"`);
    }
    expect(html).toContain('data-passport-focus="panel:life" hidden');
    expect(html).toContain('data-passport-focus="panel:record" hidden');
    const footer = html.slice(html.indexOf('<footer'));
    for (const action of ['history', 'replay', 'share']) expect(footer).toContain(`data-${action}="boar_01"`);
    expect(footer).not.toContain('hidden');
  });

  it('retains death, family and history actions for a saved life', () => {
    const { nodes, hud, store } = setup();
    hud.passport = { ...passport(), alive: false, death: { cause: 'old_age', worldTime: 1000, eventId: 'death_01' } };
    store.apply({ type: 'animals', animals: [] });
    hud.render('boar_01');
    expect(nodes.passport.innerHTML).toContain('<h2>Wild boar</h2>');
    expect(nodes.passport.innerHTML).toContain('Old age');
    expect(nodes.passport.innerHTML).toContain('death_01');
    expect(nodes.passport.innerHTML).toContain('data-follow="boar_mother"');
    expect(nodes.passport.innerHTML).toContain('<code>boar_01</code>');
    for (const action of ['history', 'replay', 'share']) expect(nodes.passport.innerHTML).toContain(`data-${action}="boar_01"`);
  });
});
