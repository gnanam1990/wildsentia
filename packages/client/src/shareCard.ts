import type { Passport } from './hud.js';
import type { AnimalState } from './protocol.js';
import { animalLink, isAnimalLinkId } from './animalLink.js';

export type SharePassport = Pick<Passport, 'id' | 'speciesId' | 'displayName' | 'ageDays' | 'lifeStage' | 'alive' | 'death' | 'timeline'
  | 'asOfWorldTime' | 'nextEventSequence'> & { state?: string; currentGoal?: string; source?: string };

/**
 * A small, deterministic observer artifact. It is deliberately plain text so a viewer can
 * paste it anywhere without executing markup. Every factual line is sourced from the current
 * checkpoint passport/live frame; narration is labelled as wording only.
 */
export interface ShareCardInput {
  passport: SharePassport | null;
  animal: AnimalState | null;
  currentUrl?: string;
}

const MAX_MOMENTS = 5;
const MAX_TEXT = 1200;

const clean = (value: unknown, fallback: string, max = 80): string => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text || fallback;
};

const age = (days: number): string => days >= 365 ? `${(days / 365).toFixed(1)} years` : `${Math.round(days)} days`;

const momentText = (moment: Passport['timeline'][number]): string =>
  `${clean(moment.type, 'event', 32)} (${clean(moment.outcome, 'unreported', 16)}) · ${moment.id} · world second ${moment.worldTime}`;

/** Build a bounded, provenance-forward card without calling a model or the network. */
export function buildShareCard(input: ShareCardInput): string {
  const p = input.passport;
  const a = input.animal;
  const id = p?.id ?? a?.id ?? '';
  const species = clean(p?.speciesId ?? a?.speciesId, 'unknown species');
  const label = clean(p?.displayName, clean(id, 'unidentified animal'));
  const state = p ? p.state : a?.state;
  const status = p?.death != null || state === 'dead' ? 'Recorded death'
    : state === 'emigrated' ? 'Departed from the forest'
    : p?.alive === false ? 'No longer active; no death record available'
    : p?.alive === true ? 'Alive at this checkpoint' : 'Live observation; passport unavailable';
  const lines = [
    `WILDSENTIA · ${label} (${species})`,
    `Animal: ${clean(id, 'unidentified', 128)}`,
    `${status}${p ? ` · ${clean(p.lifeStage, 'life stage unreported', 24)} · age ${Number.isFinite(p.ageDays) && p.ageDays >= 0 ? age(p.ageDays) : 'unreported'}` : ''}`,
  ];
  if (p?.death !== null && p?.death !== undefined) {
    lines.push(`Cause: ${clean(p.death.cause, 'unreported', 48)} · event ${clean(p.death.eventId, 'no event id', 128)}`);
  } else if (state !== undefined) {
    lines.push(`Observed state: ${clean(state, 'unreported', 32)} · goal ${clean(p ? p.currentGoal : a?.currentGoal, 'unreported', 32)}`);
  }
  const footer = [];
  if (p?.asOfWorldTime !== undefined) footer.push(`Checkpoint world time: ${p.asOfWorldTime}${p.nextEventSequence === undefined ? '' : ` · next event ${p.nextEventSequence}`}`);
  footer.push('Simulation outcomes are authoritative. Any narration only rewords recorded facts.');
  const url = input.currentUrl && animalLink(input.currentUrl, id);
  if (url) footer.push(`Observe: ${url}`);
  // Reserve provenance/link space; omit whole event lines instead of slicing facts or URLs.
  let moments = 0;
  for (const e of p?.timeline ?? []) {
    if (!isAnimalLinkId(e.id) || !Number.isSafeInteger(e.worldTime) || e.worldTime < 0
      || (p?.asOfWorldTime !== undefined && e.worldTime > p.asOfWorldTime)) continue;
    const addition = [...(moments ? [] : ['Recorded events (latest excerpt):']), momentText(e)];
    if ([...lines, ...addition, ...footer].join('\n').length > MAX_TEXT) break;
    lines.push(...addition);
    if (++moments === MAX_MOMENTS) break;
  }
  return [...lines, ...footer].join('\n');
}
