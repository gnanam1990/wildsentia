import { isAnimalLinkId } from './animalLink.js';
import { buildShareCard, type SharePassport } from './shareCard.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Only a matching saved passport may be exported as a checkpoint story. */
export function isSharePassport(value: unknown, id: string): value is SharePassport {
  if (!record(value) || value.id !== id || !isAnimalLinkId(id) || value.source !== 'checkpoint'
    || !whole(value.asOfWorldTime) || !whole(value.nextEventSequence) || typeof value.alive !== 'boolean'
    || !text(value.speciesId, 128) || !text(value.displayName) || !text(value.lifeStage, 32)
    || typeof value.ageDays !== 'number' || !Number.isFinite(value.ageDays) || value.ageDays < 0
    || !text(value.state, 64) || !text(value.currentGoal, 64)
    || !Array.isArray(value.timeline) || value.timeline.length > 50) return false;
  const until = value.asOfWorldTime;
  if (value.death !== null && (!record(value.death) || !text(value.death.cause) || !isAnimalLinkId(value.death.eventId)
    || !whole(value.death.worldTime) || value.death.worldTime > until || value.alive)) return false;
  if (value.alive && ['dead', 'emigrated'].includes(value.state)) return false;
  return value.timeline.every(e => record(e) && isAnimalLinkId(e.id) && text(e.type, 64)
    && ['success', 'failure', 'abandoned', 'interrupted'].includes(String(e.outcome))
    && whole(e.worldTime) && e.worldTime <= until);
}

/** Each open freezes one fetched passport. Late loads/copies cannot overwrite another story. */
export class ShareStory {
  id = '';
  text = '';
  status = '';
  loading = false;
  copying = false;
  #revision = 0;
  #abort: AbortController | null = null;
  constructor(private readonly changed: () => void = () => {}) {}

  close(): void { this.#revision++; this.#abort?.abort(); this.loading = false; this.copying = false; }

  async open(id: string, currentUrl: string): Promise<void> {
    this.close(); const revision = this.#revision;
    this.id = id; this.text = ''; this.status = 'Loading this animal’s saved story…'; this.loading = true; this.changed();
    this.#abort = new AbortController();
    try {
      if (!isAnimalLinkId(id)) throw new Error('Animal link is invalid. Select an animal in the forest.');
      const response = await fetch(`/api/animals/${encodeURIComponent(id)}/passport`, {
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error(response.status === 404 ? 'This animal’s record is unavailable. Select another animal or retry.' : 'Story unavailable. Please retry.');
      const passport: unknown = await response.json();
      if (revision !== this.#revision) return;
      if (!isSharePassport(passport, id)) throw new Error('Could not verify this animal’s saved record. Please retry.');
      this.text = buildShareCard({ passport, animal: null, currentUrl });
      this.status = 'Ready to copy. This excerpt stays fixed while the forest continues.';
    } catch (error) {
      if (revision === this.#revision) this.status = error instanceof Error ? error.message : 'Story unavailable. Please retry.';
    } finally { if (revision === this.#revision) { this.loading = false; this.changed(); } }
  }

  async copy(write: ((text: string) => Promise<void>) | undefined): Promise<boolean> {
    if (!this.text || this.loading || this.copying) return false;
    const revision = this.#revision;
    this.copying = true; this.status = 'Copying story…'; this.changed();
    try {
      if (!write) throw new Error('Clipboard unavailable');
      await write(this.text);
      if (revision !== this.#revision) return false;
      this.status = 'Story copied.'; return true;
    } catch {
      if (revision === this.#revision) this.status = 'Clipboard unavailable. Use Select text, then your browser’s Copy command.';
      return false;
    } finally { if (revision === this.#revision) { this.copying = false; this.changed(); } }
  }
}

export function createShareDialog(): (id: string) => void {
  const dialog = document.createElement('dialog'); dialog.className = 'forest-dialog share-dialog';
  dialog.setAttribute('aria-labelledby', 'share-title');
  const title = document.createElement('h2'); title.id = 'share-title'; title.textContent = 'Share animal story';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  const label = document.createElement('label'); label.htmlFor = 'share-text'; label.textContent = 'Story text';
  const content = document.createElement('textarea'); content.id = 'share-text'; content.readOnly = true; content.rows = 13;
  const controls = document.createElement('div'); controls.className = 'history-controls';
  const button = (label: string, action: () => void) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.onclick = action; controls.append(el); return el;
  };
  const story = new ShareStory(() => {
    status.textContent = story.status;
    // Preserve selection during asynchronous clipboard feedback.
    if (content.value !== story.text) content.value = story.text;
    content.setAttribute('aria-busy', String(story.loading));
    copy.disabled = story.loading || story.copying || !story.text;
    select.disabled = !story.text;
    retry.disabled = story.loading || story.copying;
    retry.hidden = !!story.text;
  });
  const copy = button('Copy story', () => { void story.copy(navigator.clipboard ? value => navigator.clipboard.writeText(value) : undefined); });
  const select = button('Select text', () => { content.focus(); content.select(); });
  const retry = button('Retry', () => { void story.open(story.id, location.href); });
  const close = button('Close', () => dialog.close());
  dialog.addEventListener('close', () => {
    story.close();
    const opener = [...document.querySelectorAll<HTMLButtonElement>('[data-share]')].find(b => b.dataset.share === story.id);
    (opener ?? document.querySelector<HTMLElement>('#view'))?.focus();
  });
  dialog.append(title, status, label, content, controls); document.body.append(dialog);
  return id => { if (!dialog.open) dialog.showModal(); close.focus(); void story.open(id, location.href); };
}
