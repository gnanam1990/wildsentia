/**
 * The first-visit veil: a photograph of the canopy and an honest progress line while the forest
 * loads, so a visitor far from the server sees the forest arriving rather than a black canvas.
 *
 * Progress is real: the connection, the first saved scene, then every texture and model the
 * forest asks for (three's default loading manager counts them). The veil lifts once the scene
 * is ready, nothing is still loading and a frame has been drawn; it never comes back after that.
 */

export type VeilStage = 'connecting' | 'scene' | 'assets' | 'ready';

export interface VeilState {
  connected: boolean;
  sceneReady: boolean;
  /** Items the loading manager has finished and started, since the page opened. */
  loaded: number;
  total: number;
  framesAfterReady: number;
}

/** Share of the bar each step fills: connecting is quick, the textures and models are most of it. */
const CONNECT_SHARE = 0.1, SCENE_SHARE = 0.15, ASSET_SHARE = 1 - CONNECT_SHARE - SCENE_SHARE;

export function veilProgress(s: VeilState): number {
  const assets = s.total > 0 ? Math.min(1, s.loaded / s.total) : s.sceneReady ? 1 : 0;
  const value = (s.connected ? CONNECT_SHARE : 0) + (s.sceneReady ? SCENE_SHARE : 0) + ASSET_SHARE * assets;
  return Math.max(0, Math.min(1, value));
}

export function veilStage(s: VeilState): VeilStage {
  if (!s.connected) return 'connecting';
  if (!s.sceneReady) return 'scene';
  if (s.total > s.loaded || s.framesAfterReady < 2) return 'assets';
  return 'ready';
}

export const VEIL_TEXT: Record<VeilStage, string> = {
  connecting: 'Finding the forest…',
  scene: 'Reading where every animal is…',
  assets: 'Laying the forest floor and waking the animals…',
  ready: 'Here it is.',
};

/** How long the veil may wait on slow assets once the scene is ready, ms: in a living forest new
 * animals keep walking into view, so their models never all finish at once. */
export const VEIL_ASSET_PATIENCE_MS = 2_500;

export interface VeilElements {
  root: HTMLElement;
  bar: HTMLElement;
  text: HTMLElement;
}

export class ForestVeil {
  readonly #state: VeilState = { connected: false, sceneReady: false, loaded: 0, total: 0, framesAfterReady: 0 };
  #readyAt: number | null = null;
  #lifted = false;
  #shownStage: VeilStage | null = null;

  constructor(private readonly el: VeilElements | null, private readonly now: () => number = () => performance.now()) {}

  get lifted(): boolean { return this.#lifted; }

  connected(): void { this.#state.connected = true; this.#render(); }

  sceneReady(): void {
    if (this.#state.sceneReady) return;
    this.#state.sceneReady = true; this.#state.connected = true; this.#readyAt = this.now(); this.#render();
  }

  /** From the loading manager's onProgress: items finished so far and items asked for so far. */
  assets(loaded: number, total: number): void {
    this.#state.loaded = Math.max(this.#state.loaded, loaded);
    this.#state.total = Math.max(this.#state.total, total, this.#state.loaded);
    this.#render();
  }

  /** Called after each drawn frame; lifts the veil when the forest is there to see. */
  frameDrawn(): void {
    if (this.#lifted) return;
    if (this.#state.sceneReady) this.#state.framesAfterReady++;
    const waited = this.#readyAt === null ? 0 : this.now() - this.#readyAt;
    if (veilStage(this.#state) === 'ready' || (this.#state.sceneReady && this.#state.framesAfterReady >= 2 && waited > VEIL_ASSET_PATIENCE_MS)) this.lift();
    else if (this.#state.sceneReady) this.#render();
  }

  lift(): void {
    if (this.#lifted) return;
    this.#lifted = true;
    if (!this.el) return;
    this.el.bar.style.transform = 'scaleX(1)';
    this.el.text.textContent = VEIL_TEXT.ready;
    this.el.root.classList.add('is-lifting');
    this.el.root.setAttribute('aria-busy', 'false');
    // The fade is CSS; remove the veil from the tree once it has gone (or at once without motion).
    const done = (): void => { this.el!.root.hidden = true; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else { this.el.root.addEventListener('transitionend', done, { once: true }); setTimeout(done, 1200); }
  }

  #render(): void {
    if (this.#lifted || !this.el) return;
    this.el.bar.style.transform = `scaleX(${veilProgress(this.#state).toFixed(3)})`;
    const stage = veilStage(this.#state);
    if (stage !== this.#shownStage) { this.#shownStage = stage; this.el.text.textContent = VEIL_TEXT[stage === 'ready' ? 'assets' : stage]; }
  }
}
