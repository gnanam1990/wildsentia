import { HOME_STAGES, HOME_SHELTER_THRESHOLD, homeCondition, isCommunityState, type CommunityState, type Person, type WorldPosition } from '@vana/shared';
import { withTimeout } from './abortSignals.js';

export interface CommunityPage {
  source: 'checkpoint';
  asOfWorldTime: number;
  nextEventSequence: number;
  community: CommunityState | null;
  notice: string;
  events: Array<{ id: string; type: string; worldTime: number; outcome: string; actors: string[];
    conditions?: Record<string, string | number>; effects?: Record<string, number> }>;
}
const facts = (v: unknown, numericOnly: boolean): boolean => v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v)
  && Object.entries(v).length <= 20 && Object.entries(v).every(([k, n]) => k.length <= 80
    && (typeof n === 'number' && Number.isFinite(n) || !numericOnly && typeof n === 'string' && n.length <= 200)));
export function isCommunityEvent(value: unknown, at: number, actorId: string): value is CommunityPage['events'][number] {
  if (!value || typeof value !== 'object') return false;
  const e = value as CommunityPage['events'][number];
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 160
    && typeof e.type === 'string' && e.type.length <= 80 && Number.isSafeInteger(e.worldTime) && e.worldTime >= 0
    && e.worldTime <= at && ['success', 'failure', 'abandoned', 'interrupted'].includes(e.outcome)
    && Array.isArray(e.actors) && e.actors.length <= 8 && e.actors.every(a => typeof a === 'string' && a.length <= 128)
    && facts(e.conditions, false) && facts(e.effects, true) && e.actors.includes(actorId);
}
export function isCommunityPage(value: unknown): value is CommunityPage {
  if (!value || typeof value !== 'object') return false;
  const p = value as CommunityPage;
  return p.source === 'checkpoint' && Number.isSafeInteger(p.asOfWorldTime) && p.asOfWorldTime >= 0
    && Number.isSafeInteger(p.nextEventSequence) && p.nextEventSequence >= 0
    && (p.community === null || isCommunityState(p.community) && p.community.updatedAt === p.asOfWorldTime)
    && typeof p.notice === 'string' && p.notice.length <= 2000
    && Array.isArray(p.events) && p.events.length <= 25 && (p.community !== null || p.events.length === 0)
    && p.events.every(e => isCommunityEvent(e, p.asOfWorldTime, p.community!.id));
}

/** Plain recorded facts, never a model-invented success or catch. */
export function communityEventText(e: CommunityPage['events'][number]): string {
  const litres = (value: string | number | undefined) => typeof value === 'number' ? `${value.toFixed(0)} L` : 'unrecorded volume';
  if (e.type === 'human_conceived') return `${e.worldTime} · ${e.actors[0]} and ${e.actors[1]} · conception recorded in this fictional household model; birth is not guaranteed · ${e.id}`;
  if (e.type === 'human_born') return `${e.worldTime} · ${e.actors[0]} born to ${e.actors[1]} and ${e.actors[2]} · generation ${e.conditions?.generation ?? 'unknown'} · recorded mass ${(e.effects?.massKg ?? 0).toFixed(2)} kg · ${e.id}`;
  if (e.type === 'human_pregnancy_lost') return `${e.worldTime} · pregnancy of ${e.actors[0]} and ${e.actors[1]} ended · ${String(e.conditions?.reason ?? 'reason not recorded').replaceAll('_', ' ')} · ${(e.effects?.returnedKg ?? 0).toFixed(3)} kg returned to soil · ${e.id}`;
  if (e.type === 'human_cared') return `${e.worldTime} · ${e.actors[1]} cared for ${e.actors[0]} · ${e.conditions?.relationship ?? 'household'} care · food ${Math.abs(e.effects?.foodKg ?? 0).toFixed(3)} kg, water ${Math.abs(e.effects?.waterL ?? 0).toFixed(3)} L delivered · ${e.id}`;
  if (e.type === 'human_hunt') return `${e.worldTime} · ${e.actors[0]} hunted ${e.conditions?.preySpecies ?? 'prey'} (${e.conditions?.preyId ?? 'unknown'}) · ${e.outcome}${e.conditions?.reason ? `: ${String(e.conditions.reason).replaceAll('_', ' ')}` : ''}${e.outcome === 'success' ? ` · ${(e.effects?.rawMeatKg ?? 0).toFixed(3)} kg raw meat taken; carcass ${e.conditions?.carcassId ?? 'unknown'} remains for scavengers` : ''} · ${e.id}`;
  if (e.type === 'human_died') return `${e.worldTime} · ${e.actors[0]} died · recorded cause: ${e.conditions?.cause ?? 'not recorded'} · ${e.id}`;
  if (e.type === 'building_stage') return `${e.worldTime} · ${e.actors[0]} completed home stage ${e.conditions?.from ?? 'unknown'} → ${e.conditions?.to ?? 'unknown'} · ${e.id}`;
  if (e.type === 'building_repaired') return `${e.worldTime} · ${e.actors[0]} repaired home · timber ${(e.effects?.timberKg ?? 0).toFixed(3)} kg; fibre ${(e.effects?.fibreKg ?? 0).toFixed(3)} kg · condition ${((e.effects?.conditionBefore ?? 0) * 100).toFixed(1)}% → ${((e.effects?.conditionAfter ?? 0) * 100).toFixed(1)}% · ${e.id}`;
  if (e.type === 'building_storm') return `${e.worldTime} · local storm recorded · rain ${litres(e.conditions?.rainfallL)} added to water budget; retained home materials lost: timber ${(e.effects?.timberLostKg ?? 0).toFixed(3)} kg, fibre ${(e.effects?.fibreLostKg ?? 0).toFixed(3)} kg · ${e.id}`;
  if (e.type === 'building_flooded') return `${e.worldTime} · home flood damage recorded · excess surface water ${litres(e.conditions?.excessSurfaceWaterL)}; timber ${(e.effects?.timberLostKg ?? 0).toFixed(3)} kg and fibre ${(e.effects?.fibreLostKg ?? 0).toFixed(3)} kg lost · ${e.id}`;
  if (e.type === 'building_collapsed') return `${e.worldTime} · home collapsed after ${e.conditions?.cause ?? 'recorded damage'} · ${(e.effects?.salvagedTimberKg ?? 0).toFixed(3)} kg timber and ${(e.effects?.salvagedFibreKg ?? 0).toFixed(3)} kg fibre salvaged; no completed shelter · ${e.id}`;
  if (e.type === 'building_rebuilt') return `${e.worldTime} · ${e.actors[0]} completed recorded home reconstruction after collapse · rebuild count ${e.effects?.rebuildsCompleted ?? 0} · ${e.id}`;
  if (e.type === 'building_shelter_changed') return `${e.worldTime} · home ${e.conditions?.availability} · ${e.conditions?.reason} · ${e.id}`;
  if (e.type === 'human_skill_learned') return `${e.worldTime} · ${e.actors[0]} learned ${e.conditions?.skill ?? 'a skill'} by working alongside ${e.actors[1]} · recorded gain ${((e.effects?.skillGain ?? 0) * 100).toFixed(2)} percentage points · ${e.id}`;
  if (e.type === 'human_cooperated') return `${e.worldTime} · ${e.actors[0]} and ${e.actors[1]} · ${((e.effects?.sharedWorkSeconds ?? 0) / 3600).toFixed(2)} shared work hours recorded · ${e.id}`;
  const action = typeof e.conditions?.action === 'string' ? e.conditions.action.replaceAll('_', ' ') : e.type;
  const reason = typeof e.conditions?.reason === 'string' ? ` · ${e.conditions.reason.replaceAll('_', ' ')}` : '';
  const changes = ['rawFishKg', 'rawMeatKg', 'foodKg', 'fishBiomassKg', 'fuelKg', 'waterL', 'timberKg', 'fibreKg'].flatMap(key => {
    const n = e.effects?.[key]; return n === undefined ? [] : [`${key}: ${n.toFixed(3)}`];
  });
  const result = e.type === 'human_task_started' ? 'attempt started; outcome not yet known'
    : `${e.type} · ${e.outcome}`;
  const site = typeof e.conditions?.sourcePatchId === 'number' ? ` · recorded site: patch ${e.conditions.sourcePatchId}`
    : typeof e.conditions?.destinationPatchId === 'number' ? ` · planned destination: patch ${e.conditions.destinationPatchId}` : '';
  return `${e.worldTime} · ${action} · ${result}${reason}${site}${changes.length ? ` · ${changes.join(', ')}` : ''} · ${e.id}`;
}

/** Saved intention, not a promise of arrival, successful gathering or a fabricated ETA. */
export function communityJourneyText(p: Person): string {
  if (!p.task) return 'No active task.';
  const t = p.task, route = t.journey;
  const place = route ? `Saved location: patch ${p.patchId}. Destination: patch ${route.destinationPatchId}. ` : '';
  const stage = t.phase === 'travel' ? `Travelling${route ? `; ${route.waypoints.length} route waypoints remaining` : ''}`
    : `Working at the destination; ${Math.ceil(t.remainingSeconds)} world seconds of task work remaining`;
  return `${place}Intention: ${t.kind.replaceAll('_', ' ')}. ${stage}. Outcome is not guaranteed. Task ${t.eventId}.`;
}

/** Only the saved v7 kinship fields are used; shared work is a separate relationship. */
export function communityFamilyText(p: Person, c: CommunityState): string {
  if (c.version < 7) return '';
  const name = (id: string | null | undefined) => id ? `${c.people.find(person => person.id === id)?.name ?? id} (${id})` : 'not recorded';
  const origin = p.generation === 0 ? 'Founding resident; parentage is not recorded.'
    : `Born at world second ${Math.floor(p.bornAt ?? 0)}. Mother: ${name(p.motherId)}. Father: ${name(p.fatherId)}.`;
  const pregnancy = p.pregnancy ? ` Recorded pregnancy with ${name(p.pregnancy.fatherId)}: conceived at world second ${Math.floor(p.pregnancy.conceivedAt)}, model due time ${Math.floor(p.pregnancy.dueAt)}; retained fetal mass ${p.pregnancy.fetusKg.toFixed(2)} kg. Birth is not guaranteed.` : '';
  return `Generation ${p.generation ?? 0}. ${origin}${pregnancy}`;
}

/** Text labels expose measured co-work, not invented friendship or off-screen teaching. */
export function communityRelationshipText(c: CommunityState): string[] {
  if (c.version < 3) return ['This older household has no shared-work learning records.'];
  if (!c.relationships?.length) return ['No shared work recorded yet. Only overlapping work within 3 metres counts.'];
  const name = (id: string) => c.people.find(p => p.id === id)?.name ?? id;
  return c.relationships.map(r => {
    const lessons = r.lessons.map(l => `${name(l.learnerId)} observed ${name(l.teacherId)}: ${l.skill} +${(l.gain * 100).toFixed(2)} percentage points over ${(l.observedSeconds / 3600).toFixed(2)} hours`);
    return `${name(r.members[0])} and ${name(r.members[1])} · ${(r.sharedWorkSeconds / 3600).toFixed(2)} shared work hours · cooperation score ${(r.trust * 100).toFixed(1)}% · last worked together at world second ${Math.floor(r.lastInteractionAt)}.${lessons.length ? ` ${lessons.join('; ')}.` : ' No observational skill gain recorded.'}`;
  });
}

export function communityHomeText(c: CommunityState): string {
  if (c.version < 4) return 'This older household has no weathering or repair rules.';
  const m = c.building.maintenance!;
  if (c.version >= 8 && m.collapses! > m.rebuildsCompleted!) {
    return `Home collapsed ${m.collapses} time${m.collapses === 1 ? '' : 's'}; the household is rebuilding from ${c.building.stage}. No completed shelter is available. Last collapse at world second ${Math.floor(m.lastCollapseAt!)}. Retained materials and completed stage work shown below are authoritative; visible debris is illustrative.`;
  }
  if (c.building.stage !== 'occupied') return 'Home still under construction; weathering begins after completion. No completed shelter yet.';
  const condition = homeCondition(c);
  return `Home condition ${(condition * 100).toFixed(1)}% · ${condition >= HOME_SHELTER_THRESHOLD ? 'habitable shelter' : 'uninhabitable; residents have no shelter benefit'}. Retained timber ${c.building.materials.timberKg.toFixed(2)} / 96 kg; fibre ${c.building.materials.fibreKg.toFixed(2)} / 72 kg. Repairs completed: ${m.repairsCompleted}.${m.lastRepairAt === null ? ' No repairs yet.' : ` Last repair at world second ${Math.floor(m.lastRepairAt)}.`} Weathering returns lost material to soil; repairs consume delivered supplies and work time. Poor shelter reduces sleep recovery.`;
}

/** On-demand only. Closing or reopening cancels stale responses; observation never advances time. */
export class CommunityObserver {
  page: CommunityPage | null = null;
  loading = false;
  error = '';
  #revision = 0;
  #abort: AbortController | null = null;
  constructor(private readonly change: () => void = () => {}) {}
  close(): void { this.#revision++; this.#abort?.abort(); this.loading = false; }
  async refresh(): Promise<void> {
    this.close(); const revision = this.#revision; this.#abort = new AbortController();
    this.page = null; this.error = ''; this.loading = true; this.change();
    try {
      const response = await fetch('/api/community', { signal: withTimeout(this.#abort.signal, 15000) });
      if (!response.ok) throw new Error('Saved community unavailable. Try refresh after the world reconnects.');
      const page: unknown = await response.json();
      if (revision !== this.#revision) return;
      if (!isCommunityPage(page)) throw new Error('Invalid community checkpoint. No community data was displayed.');
      this.page = page;
    } catch (e) { if (revision === this.#revision) this.error = e instanceof Error ? e.message : 'Community unavailable.'; }
    finally { if (revision === this.#revision) { this.loading = false; this.change(); } }
  }
}

export function createCommunityDialog(focus: (position: WorldPosition, distance: number) => void, history?: (id: string) => void,
  watchPerson?: (id: string) => void): () => void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog community-dialog';
  dialog.setAttribute('aria-labelledby', 'community-title');
  const header = document.createElement('header'); header.className = 'dialog-header';
  const title = document.createElement('h2'); title.id = 'community-title'; title.textContent = 'Community observer';
  const status = document.createElement('p'); status.className = 'dialog-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  const controls = document.createElement('div'); controls.className = 'history-controls dialog-actions';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh checkpoint';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Back to forest'; close.onclick = () => dialog.close();
  controls.append(refresh, close);
  header.append(title, controls);
  const content = document.createElement('div'); content.className = 'community-content';
  let opener: HTMLElement | null = null;
  let restoreFocus = true;
  const line = (parent: HTMLElement, text: string, tag = 'p'): HTMLElement => {
    const e = document.createElement(tag); e.textContent = text; parent.append(e); return e;
  };
  const section = (parent: HTMLElement, className: string, heading?: string): HTMLElement => {
    const e = document.createElement('section'); e.className = className;
    if (heading) line(e, heading, 'h3');
    parent.append(e); return e;
  };
  const details = (parent: HTMLElement, label: string): HTMLDetailsElement => {
    const e = document.createElement('details'); e.className = 'community-details';
    line(e, label, 'summary'); parent.append(e); return e;
  };
  const measurements = (parent: HTMLElement, className: string, values: Array<[string, string]>): void => {
    const list = document.createElement('dl'); list.className = className;
    for (const [label, value] of values) {
      const entry = document.createElement('div');
      line(entry, label, 'dt'); line(entry, value, 'dd'); list.append(entry);
    }
    parent.append(list);
  };
  const locate = (parent: HTMLElement, label: string, position: WorldPosition, distance = 8) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.onclick = () => { restoreFocus = false; dialog.close(); focus(position, distance); }; parent.append(b);
  };
  const observer = new CommunityObserver(() => {
    refresh.disabled = observer.loading; content.setAttribute('aria-busy', String(observer.loading));
    status.textContent = observer.loading ? 'Loading saved household…' : observer.error
      || (observer.page ? `Saved world second ${observer.page.asOfWorldTime}. Refresh to see later progress.` : '');
    content.replaceChildren();
    const page = observer.page;
    if (!page) return;
    if (!page.community) { line(content, 'This saved world has no human settlement. Observing cannot add one or reset the forest.'); return; }
    const c = page.community, b = c.building, stage = HOME_STAGES.find(s => s.from === b.stage);
    const home = section(content, 'community-summary', c.name);
    line(home, `Home: ${b.stage} · ${c.people.filter(p => p.alive).length} living residents`).className = 'community-home-state';
    measurements(home, 'community-stocks', [
      ['Stored food', `${c.stores.foodKg.toFixed(1)} kg`], ['Water', `${c.stores.waterL.toFixed(1)} L`],
      ['Timber', `${c.stores.timberKg.toFixed(1)} kg`], ['Fibre', `${c.stores.fibreKg.toFixed(1)} kg`],
    ]);
    const homeActions = document.createElement('div'); homeActions.className = 'dialog-actions'; home.append(homeActions);
    locate(homeActions, 'View saved home location', b.position, 45);
    const homeDetails = details(home, 'Home and building records');
    line(homeDetails, `${c.name} · ${c.householdId}`);
    line(homeDetails, `Home: ${b.stage}. Stored food ${c.stores.foodKg.toFixed(1)} kg; water ${c.stores.waterL.toFixed(1)} L; timber ${c.stores.timberKg.toFixed(1)} kg; fibre ${c.stores.fibreKg.toFixed(1)} kg.`);
    line(homeDetails, communityHomeText(c));
    if (c.version >= 2) line(homeDetails, `Stored raw fish: ${c.stores.rawFishKg!.toFixed(3)} kg (not ready to eat).`);
    if (c.version >= 6) line(homeDetails, `Stored raw meat: ${c.stores.rawMeatKg!.toFixed(3)} kg (not ready to eat). Hunting takes meat only after contact and a recorded success; the carcass stays in the forest.`);
    if (stage) line(homeDetails, `Next: ${stage.to}. Requires ${stage.timberKg} kg timber, ${stage.fibreKg} kg fibre and ${stage.labourSeconds / 3600} skill-weighted work hours. Work completed: ${(b.labourSeconds / 3600).toFixed(1)} hours.`);
    else line(homeDetails, `Shelter available for ${b.occupantIds.length} residents. Completed at world second ${Math.floor(b.completedAt!)}; resident IDs are not live indoor positions.`);
    const people = section(content, 'community-section', 'People · saved needs, family and intentions');
    const list = document.createElement('ul'); list.className = 'community-people'; people.append(list);
    for (const p of c.people) {
      const item = document.createElement('li'); item.className = 'community-person'; list.append(item);
      const personHeader = document.createElement('header'); personHeader.className = 'person-header'; item.append(personHeader);
      line(personHeader, p.name, 'h4');
      line(personHeader, `${(p.ageDays / 360).toFixed(1)} world years`).className = 'person-age';
      const activity = !p.alive ? `Died at world second ${Math.floor(p.diedAt!)}. History remains.`
        : p.task ? `Saved task: ${p.task.kind.replaceAll('_', ' ')} · ${p.task.phase === 'travel' ? 'travelling' : 'at destination'}.`
        : 'No active task.';
      line(personHeader, activity).className = 'person-activity';
      const actions = document.createElement('div'); actions.className = 'person-actions dialog-actions'; item.append(actions);
      if (watchPerson && p.massKg > 0) {
        const watch = document.createElement('button'); watch.type = 'button'; watch.textContent = `Watch ${p.name}`;
        watch.onclick = () => { restoreFocus = false; dialog.close(); watchPerson(p.id); }; actions.append(watch);
      } else locate(actions, `View ${p.name}'s saved location`, p.position);
      if (history) {
        const open = document.createElement('button'); open.type = 'button'; open.textContent = `Read ${p.name}'s retained history`;
        open.onclick = () => { restoreFocus = false; dialog.close(); history(p.id); }; actions.append(open);
      }
      if (p.alive) measurements(item, 'person-needs', [
        ['Health', `${Math.round(p.health * 100)}%`], ['Hunger', `${Math.round(p.needs.hunger * 100)}%`],
        ['Thirst', `${Math.round(p.needs.thirst * 100)}%`], ['Fatigue', `${Math.round(p.needs.fatigue * 100)}%`],
      ]);
      const record = details(item, 'Life and recorded details');
      line(record, `${p.name} · ${p.id} · ${(p.ageDays / 360).toFixed(1)} world years`);
      line(record, p.alive ? `Health ${Math.round(p.health * 100)}%. Hunger ${Math.round(p.needs.hunger * 100)}%, thirst ${Math.round(p.needs.thirst * 100)}%, fatigue ${Math.round(p.needs.fatigue * 100)}%.` : `Died at world second ${Math.floor(p.diedAt!)}. History remains.`);
      if (c.version >= 7) {
        line(record, communityFamilyText(p, c));
        if (p.ageDays < 6 * 360) line(record, `Dependent child · ${(p.ageDays / 360).toFixed(1)} world years · saved hunger ${Math.round(p.needs.hunger * 100)}%, thirst ${Math.round(p.needs.thirst * 100)}%. Childcare requires a recorded caregiver, supplies and close contact; it may fail.`);
        if (p.task?.kind === 'care_child') line(record, `Care intention for ${c.people.find(child => child.id === p.task?.targetPersonId)?.name ?? p.task.targetPersonId ?? 'unknown child'}. The recorded outcome appears in household milestones.`);
      }
      line(record, communityJourneyText(p));
      if (c.version >= 5) line(record, `${p.visitedSites!.length} visited sites remembered. People inspect nearby resources and explore land routes; remembered visits are not live knowledge of distant supplies.`);
      line(record, `Carrying: ${p.inventory.foodKg.toFixed(1)} kg food, ${p.inventory.waterL.toFixed(1)} L water, ${p.inventory.timberKg.toFixed(1)} kg timber, ${p.inventory.fibreKg.toFixed(1)} kg fibre.`);
      line(record, `Skills: gathering ${(p.skills.gathering * 100).toFixed(1)}%; building ${(p.skills.building * 100).toFixed(1)}%.`);
      if (c.version >= 2) line(record, `Raw fish carried: ${p.inventory.rawFishKg!.toFixed(3)} kg. Fishing skill: ${(p.skills.fishing! * 100).toFixed(1)}%.`);
      if (c.version >= 6) line(record, `Raw meat carried: ${p.inventory.rawMeatKg!.toFixed(3)} kg. Hunting skill: ${(p.skills.hunting! * 100).toFixed(1)}%.`);
    }
    const sharedWork = section(content, 'community-section', 'Shared work and learning');
    const relationships = document.createElement('ul'); relationships.className = 'community-relationships'; sharedWork.append(relationships);
    for (const text of communityRelationshipText(c)) line(relationships, text, 'li');
    const milestones = section(content, 'community-section', 'Recent household milestones and food work');
    const events = document.createElement('ol'); events.className = 'community-events'; milestones.append(events);
    for (const e of page.events) line(events, communityEventText(e), 'li');
    if (!page.events.length) line(milestones, 'No household milestones recorded at this checkpoint.').className = 'dialog-note';
    const about = details(content, 'About this simulation');
    line(about, page.notice);
    line(about, c.version >= 2 ? `Household rules v${c.version} · raw catch must be delivered and cooked with fuel before eating.`
      : 'Saved household rules v1 · fishing and cooking are not enabled in this older world.');
    line(about, 'The cooperation score measures time worked together, not emotions or kinship. Learning comes from nearby, more-skilled people doing the same work; it does not guarantee a successful task.');
    line(about, 'Latest 25 recorded household milestones, including family and care events; routine resting is omitted. Older routine tasks may be pruned. Nearby people load CC0 game-style character rigs; distant, loading or failed models remain location markers (reload to retry a failed download). People walk their actual paths and tasks as each hour plays; between hours they stay where they are, with no guessed routes. Poses and smaller child rigs are illustrative, not a reconstruction of any real community or a guarantee of task success.');
  });
  refresh.onclick = () => { void observer.refresh(); };
  dialog.append(header, status, content); document.body.append(dialog);
  dialog.addEventListener('close', () => { observer.close(); if (restoreFocus) opener?.focus(); });
  return () => { restoreFocus = true; opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal(); void observer.refresh(); };
}
