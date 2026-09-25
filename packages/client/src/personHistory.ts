import { communityEventText, isCommunityEvent, type CommunityPage } from './communityObserver.js';
import { createHistoryDialog, isHistoryPage, type HistoryPage, type HistorySource } from './history.js';
import { createHumanMotionPanel, type HistoricHumanFrame } from './humanHistoryReplay.js';

export interface PersonHistoryPage extends HistoryPage {
  source: 'checkpoint';
  personId: string;
  events: CommunityPage['events'];
}
export const personHistoryUrl = (id: string, cursor?: string | null): string =>
  `/api/people/${encodeURIComponent(id)}/events?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
export function isPersonHistoryPage(value: unknown, id: string): value is PersonHistoryPage {
  if (!isHistoryPage(value)) return false;
  const p = value as PersonHistoryPage;
  return p.source === 'checkpoint' && p.personId === id && p.retention.length <= 2000
    && new Set(p.events.map(e => e.id)).size === p.events.length
    && p.events.every(e => isCommunityEvent(e, p.asOfWorldTime, id));
}
export const personHistorySource: HistorySource = { url: personHistoryUrl, validate: isPersonHistoryPage };
/** Event biography and a separate, explicitly recorded movement replay. */
export function createPersonHistoryDialog(back: () => void, onMotionFrame: (frame: HistoricHumanFrame | null) => void = () => {}): (id: string) => void {
  const openHistory = createHistoryDialog(undefined, { titleId: 'person-history-title', title: 'Person retained history',
    source: personHistorySource, eventText: event => communityEventText(event as CommunityPage['events'][number]),
    emptyText: 'No retained events for this person at this saved checkpoint; no past was reconstructed.', onClose: back });
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog.history-dialog')].at(-1)!;
  const panel = createHumanMotionPanel(onMotionFrame);
  dialog.insertBefore(panel.element, dialog.querySelector('ol'));
  dialog.addEventListener('close', panel.close);
  return id => { panel.close(); openHistory(id); panel.open(id); };
}
