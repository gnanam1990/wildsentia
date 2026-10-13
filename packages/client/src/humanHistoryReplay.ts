import { worldGrid } from './worldGrid.js';
import { humanMotionAt, isWorldPosition, MAX_HUMAN_MOTION_SAMPLES, type HumanMotionSample } from '@vana/shared';
import { withTimeout } from './abortSignals.js';

export interface RecordedHumanWindow { startWorldTime: number; endWorldTime: number; samples: HumanMotionSample[] }
export interface HumanMotionPage {
  source: 'checkpoint'; personId: string; asOfWorldTime: number; nextEventSequence: number;
  windows: RecordedHumanWindow[]; pageCursor: string; nextCursor: string | null; retention: string;
}
/** A view command only; it cannot affect the simulation or fill an unrecorded interval. */
export type HistoricHumanFrame = {
  personId: string; worldTime: number | null; secondsInWindow: number | null;
  source: 'loading' | 'recorded' | 'gap' | 'unavailable';
  sample: (HumanMotionSample & { moving: boolean }) | null;
};
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const validCursor = (v: unknown): v is string | null => v === null || typeof v === 'string' && v.length > 0 && v.length <= 4096;
const validSample = (v: unknown): v is HumanMotionSample => {
  if (!v || typeof v !== 'object') return false;
  const s = v as HumanMotionSample;
  return typeof s.seconds === 'number' && Number.isFinite(s.seconds) && s.seconds >= 0
    && isWorldPosition(worldGrid(), s.position) && typeof s.alive === 'boolean'
    && (s.action === null || typeof s.action === 'string' && ['gather_food', 'collect_water', 'gather_timber',
      'gather_fibre', 'deliver', 'eat', 'drink', 'sleep', 'build', 'rest', 'fish', 'cook', 'repair',
      'seek_resources', 'hunt', 'care_child'].includes(s.action))
    && (s.phase === null || s.phase === 'travel' || s.phase === 'work')
    && (s.taskEventId === null || typeof s.taskEventId === 'string' && s.taskEventId.length > 0 && s.taskEventId.length <= 128)
    && (s.action === null) === (s.phase === null) && (s.phase === null) === (s.taskEventId === null)
    && (s.alive || s.action === null);
};
export function isHumanMotionPage(value: unknown, id: string): value is HumanMotionPage {
  if (!value || typeof value !== 'object') return false;
  const p = value as HumanMotionPage;
  if (p.source !== 'checkpoint' || p.personId !== id || !whole(p.asOfWorldTime) || !whole(p.nextEventSequence)
    || typeof p.retention !== 'string' || typeof p.pageCursor !== 'string' || !validCursor(p.pageCursor)
    || !validCursor(p.nextCursor) || !Array.isArray(p.windows) || p.windows.length > 48) return false;
  let previousStart = Infinity;
  for (const w of p.windows) {
    if (!whole(w.startWorldTime) || !whole(w.endWorldTime) || w.endWorldTime > p.asOfWorldTime
      || w.endWorldTime <= w.startWorldTime || w.endWorldTime - w.startWorldTime > 3600
      || w.endWorldTime > previousStart || !Array.isArray(w.samples)
      || w.samples.length < 2 || w.samples.length > MAX_HUMAN_MOTION_SAMPLES) return false;
    previousStart = w.startWorldTime;
    let previous: HumanMotionSample | null = null;
    for (const s of w.samples) {
      if (!validSample(s) || s.seconds > w.endWorldTime - w.startWorldTime) return false;
      if (previous) {
        const dt = s.seconds - previous.seconds;
        const distance = Math.hypot(s.position.x - previous.position.x, s.position.z - previous.position.z);
        if (dt <= 0 || !previous.alive && s.alive || distance > dt * 1.1 + 1e-5
          || distance > 1e-6 && previous.phase !== 'travel') return false;
      } else if (s.seconds !== 0) return false;
      previous = s;
    }
    if (previous!.seconds !== w.endWorldTime - w.startWorldTime) return false;
  }
  return true;
}

export const humanMotionUrl = (id: string, cursor?: string | null): string =>
  `/api/people/${encodeURIComponent(id)}/motion?limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

/** Return a pose only inside an actually stored window; never bridge or extrapolate a gap. */
export function recordedHumanPose(windows: readonly RecordedHumanWindow[], worldTime: number):
  (HumanMotionSample & { moving: boolean }) | null {
  if (!Number.isFinite(worldTime)) return null;
  const window = windows.find(w => w.startWorldTime <= worldTime && worldTime <= w.endWorldTime);
  return window ? humanMotionAt(window.samples, worldTime - window.startWorldTime) : null;
}

export function recordedHumanGaps(windows: readonly RecordedHumanWindow[]): Array<{ from: number; to: number }> {
  const ordered = [...windows].sort((a, b) => a.startWorldTime - b.startWorldTime);
  const gaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < ordered.length; i++) if (ordered[i]!.startWorldTime > ordered[i - 1]!.endWorldTime)
    gaps.push({ from: ordered[i - 1]!.endWorldTime, to: ordered[i]!.startWorldTime });
  return gaps;
}

export function historicHumanFrame(page: HumanMotionPage, worldTime: number): HistoricHumanFrame {
  const sample = recordedHumanPose(page.windows, worldTime);
  const window = sample ? page.windows.find(w => w.startWorldTime <= worldTime && worldTime <= w.endWorldTime) : null;
  return { personId: page.personId, worldTime, secondsInWindow: window ? worldTime - window.startWorldTime : null,
    source: sample ? 'recorded' : 'gap', sample };
}

export class HumanMotionPager {
  id = ''; page: HumanMotionPage | null = null; pageNumber = 0; loading = false; error = '';
  #cursors: Array<string | null> = []; #revision = 0; #abort: AbortController | null = null;
  constructor(private readonly change: () => void = () => {}) {}
  get hasPrevious(): boolean { return this.pageNumber > 1; }
  close(): void { this.#revision++; this.#abort?.abort(); this.loading = false; }
  async open(id: string): Promise<void> {
    this.close(); this.id = id; this.page = null; this.pageNumber = 0; this.#cursors = [];
    await this.#load(null, 1);
  }
  async next(): Promise<void> { if (!this.loading && this.page?.nextCursor) await this.#load(this.page.nextCursor, this.pageNumber + 1); }
  async previous(): Promise<void> {
    if (!this.loading && this.hasPrevious) await this.#load(this.#cursors[this.pageNumber - 2]!, this.pageNumber - 1);
  }
  async #load(cursor: string | null, pageNumber: number): Promise<void> {
    const revision = ++this.#revision, id = this.id;
    this.#abort?.abort(); this.#abort = new AbortController();
    this.loading = true; this.error = ''; this.change();
    try {
      const response = await fetch(humanMotionUrl(id, cursor), { signal: withTimeout(this.#abort.signal, 15000) });
      if (!response.ok) throw new Error(response.status === 400 ? 'Recording cursor expired. Start again.' : 'Recorded movement unavailable. Retry.');
      const page: unknown = await response.json();
      if (revision !== this.#revision) return;
      if (!isHumanMotionPage(page, id)) throw new Error('Invalid recorded movement. Start again.');
      if (cursor && this.page && (page.asOfWorldTime !== this.page.asOfWorldTime || page.nextEventSequence !== this.page.nextEventSequence))
        throw new Error('Recording checkpoint changed. Start again.');
      this.page = page; this.pageNumber = pageNumber; this.#cursors[pageNumber - 1] = page.pageCursor;
    } catch (error) {
      if (revision === this.#revision) this.error = error instanceof Error ? error.message : 'Recorded movement unavailable.';
    } finally { if (revision === this.#revision) { this.loading = false; this.change(); } }
  }
}

/** A deliberately local trajectory plot: each saved hour is a separate line; gaps have no line or pose. */
export function createHumanMotionPanel(onFrame: (frame: HistoricHumanFrame | null) => void = () => {}):
  { element: HTMLDetailsElement; open: (id: string) => void; close: () => void } {
  const element = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Replay recorded movement';
  summary.style.cssText = 'cursor:pointer;min-height:44px;padding:10px 0;font-weight:650';
  const explanation = document.createElement('p');
  explanation.textContent = 'The map and 3D person follow executed, saved hourly motion. Missing hours have no path or 3D person. The visible building and terrain remain at the newer checkpoint; the generic person rig and task pose are illustrative.';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
  const controls = document.createElement('div'); controls.className = 'history-controls';
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = action; controls.append(b); return b;
  };
  let raf = 0, previousFrame = 0, rendered: HumanMotionPage | null = null;
  const pause = (refresh = true): void => { if (raf) cancelAnimationFrame(raf); raf = 0; previousFrame = 0; play.textContent = 'Play recorded page';
    if (refresh && pager.page?.windows.length) showPose(); };
  const newer = button('Newer recordings', () => { pause(false); void pager.previous(); });
  const older = button('Older recordings', () => { pause(false); void pager.next(); });
  const restart = button('Start recordings again', () => { pause(false); void pager.open(pager.id); });
  const play = button('Play recorded page', () => {
    if (raf) { pause(); return; }
    if (!pager.page?.windows.length) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { status.textContent = 'Reduced motion is enabled. Use the recorded-time slider.'; return; }
    play.textContent = 'Pause playback';
    const frame = (now: number): void => {
      const elapsed = previousFrame ? Math.max(0, Math.min(100, now - previousFrame)) : 0;
      previousFrame = now;
      slider.value = String(Math.min(Number(slider.max), Number(slider.value) + elapsed * 1.44));
      showPose();
      if (Number(slider.value) >= Number(slider.max)) pause(); else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  });
  const timeLabel = document.createElement('label'); timeLabel.textContent = 'Recorded world second';
  const slider = document.createElement('input'); slider.type = 'range'; slider.step = '1'; slider.min = '0'; slider.max = '1';
  slider.style.width = '100%'; slider.setAttribute('aria-label', 'Recorded world second'); slider.oninput = () => { pause(false); showPose(); };
  timeLabel.append(slider);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 600 240'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Recorded movement paths, one separate line per saved window');
  svg.style.cssText = 'display:block;width:100%;min-height:180px;background:#0b1811;border:1px solid #738d78;border-radius:8px';
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  marker.setAttribute('r', '7'); marker.setAttribute('fill', '#e9f1e9'); marker.setAttribute('stroke', '#14231b'); marker.setAttribute('stroke-width', '2');
  const gaps = document.createElement('p');
  let map: (x: number, z: number) => [number, number] = () => [300, 120];
  const draw = (page: HumanMotionPage): void => {
    svg.replaceChildren();
    const points = page.windows.flatMap(w => w.samples.map(s => s.position));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const span = Math.max(1, maxX - minX, maxZ - minZ);
    map = (x, z) => [300 + (x - (minX + maxX) / 2) * 190 / span,
      120 + (z - (minZ + maxZ) / 2) * 190 / span];
    for (const window of page.windows) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', window.samples.map(s => map(s.position.x, s.position.z).join(',')).join(' '));
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#84c8dc'); line.setAttribute('stroke-width', '3');
      line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-linejoin', 'round'); svg.append(line);
    }
    svg.append(marker);
    const missing = recordedHumanGaps(page.windows);
    gaps.textContent = missing.length ? `${missing.length} missing interval${missing.length === 1 ? '' : 's'} on this page: ${missing.map(g => `${g.from}–${g.to}`).join(', ')}. No path is drawn across them.`
      : 'No missing intervals between the recorded windows on this page. Earlier pages may still be missing.';
  };
  const showPose = (): void => {
    const page = pager.page, time = Number(slider.value);
    if (!page?.windows.length) { marker.style.display = 'none'; return; }
    const frame = historicHumanFrame(page, time), pose = frame.sample;
    if (element.open) onFrame(frame);
    if (!pose) {
      marker.style.display = 'none';
      const gap = recordedHumanGaps(page.windows).find(g => g.from < time && time < g.to);
      const detail = gap ? `World second ${Math.round(time)} · no recording between ${gap.from} and ${gap.to}; position unknown.`
        : `World second ${Math.round(time)} · no recorded position.`;
      slider.setAttribute('aria-valuetext', detail);
      const message = raf ? 'Playing across an unrecorded interval; position unknown.' : detail;
      if (status.textContent !== message) status.textContent = message;
      return;
    }
    const [x, y] = map(pose.position.x, pose.position.z);
    marker.style.display = ''; marker.setAttribute('cx', String(x)); marker.setAttribute('cy', String(y));
    const activity = pose.alive ? pose.action ? `${pose.action.replaceAll('_', ' ')} (${pose.phase})` : 'idle' : 'deceased';
    const detail = `World second ${Math.round(time)} · recorded position ${pose.position.x.toFixed(1)}, ${pose.position.z.toFixed(1)} · ${activity}.`;
    slider.setAttribute('aria-valuetext', detail);
    const message = raf ? `Playing saved hourly movement · ${activity}.` : detail;
    if (status.textContent !== message) status.textContent = message;
  };
  const pager = new HumanMotionPager(() => {
    newer.disabled = pager.loading || !pager.hasPrevious;
    older.disabled = pager.loading || !pager.page?.nextCursor;
    restart.disabled = pager.loading;
    play.disabled = pager.loading || !pager.page?.windows.length;
    slider.disabled = pager.loading || !pager.page?.windows.length;
    if (pager.loading) { status.textContent = 'Loading recorded movement…'; if (element.open) onFrame({ personId: pager.id, worldTime: null, secondsInWindow: null, source: 'loading', sample: null }); }
    else if (pager.error) { status.textContent = pager.error; if (element.open) onFrame({ personId: pager.id, worldTime: null, secondsInWindow: null, source: 'unavailable', sample: null }); }
    else if (pager.page?.windows.length === 0) {
      status.textContent = 'No saved movement for this person at this checkpoint. Older snapshots do not have replay recordings.';
      if (element.open) onFrame({ personId: pager.id, worldTime: null, secondsInWindow: null, source: 'unavailable', sample: null });
      svg.replaceChildren(); gaps.textContent = pager.page.retention;
    } else if (pager.page && pager.page !== rendered) {
      rendered = pager.page;
      const windows = pager.page.windows, oldest = windows.at(-1)!, newest = windows[0]!;
      slider.min = String(oldest.startWorldTime); slider.max = String(newest.endWorldTime); slider.value = slider.min;
      draw(pager.page); showPose();
    }
  });
  element.append(summary, explanation, controls, timeLabel, svg, status, gaps);
  element.addEventListener('toggle', () => {
    if (!element.open) { pause(false); onFrame(null); }
    else if (pager.page?.windows.length) showPose();
    else if (pager.loading) onFrame({ personId: pager.id, worldTime: null, secondsInWindow: null, source: 'loading', sample: null });
  });
  return { element, open(id) { pause(false); rendered = null; svg.replaceChildren(); gaps.textContent = ''; element.open = true; void pager.open(id); },
    close() { pause(false); pager.close(); rendered = null; element.open = false; onFrame(null); } };
}
