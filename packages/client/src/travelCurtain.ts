/**
 * A short curtain while the camera cuts to an animal in another part of the forest. Its regions
 * are still on their way from the server and the first frame there builds the ground and plants
 * them, so for a moment there is nothing right to show. The curtain covers exactly that moment:
 * it lifts as soon as the animal is drawn (and two frames have followed), or after a few seconds.
 */
export const CURTAIN_MAX_MS = 8_000;

export class TravelCurtain {
  #shownAt: number | null = null;
  #framesSincePlaced: number | null = null;
  #waitingFor: number | null = null;
  #nextScene = false;
  #maxMs = CURTAIN_MAX_MS;

  constructor(private readonly el: HTMLElement | null, private readonly now: () => number = () => performance.now()) {}

  get showing(): boolean { return this.#shownAt !== null; }
  /** The patch whose region the curtain waits for, when the destination's patch is known. */
  get waitingFor(): number | null { return this.#shownAt === null ? null : this.#waitingFor; }

  /**
   * @param waitingFor the destination's patch, when its region is still to be built
   * @param nextScene lift on the next scene built (the destination is loaded, but the regions round it change)
   */
  show(text: string, waitingFor: number | null = null, nextScene = false, maxMs = CURTAIN_MAX_MS): void {
    this.#shownAt = this.now(); this.#framesSincePlaced = null; this.#waitingFor = waitingFor;
    this.#nextScene = nextScene; this.#maxMs = maxMs;
    if (!this.el) return;
    const label = this.el.querySelector('.curtain-text');
    if (label) label.textContent = text;
    this.el.hidden = false;
    this.el.classList.remove('is-lifting');
    this.el.setAttribute('aria-busy', 'true');
  }

  /** The destination is ready: its region has been built, or the animal has been drawn there. */
  arrived(): void { if (this.#shownAt !== null && this.#framesSincePlaced === null) this.#framesSincePlaced = 0; }

  /** The animal has been drawn: enough when the curtain waits for nothing else (a far animal found by asking). */
  drawn(): void { if (this.#waitingFor === null && !this.#nextScene) this.arrived(); }

  /** A scene for the view has just been built. */
  sceneBuilt(loaded: (patch: number) => boolean): void {
    if (this.#shownAt === null) return;
    if (this.#nextScene || (this.#waitingFor !== null && loaded(this.#waitingFor))) this.arrived();
  }

  /** After each drawn frame. */
  frameDrawn(): void {
    if (this.#shownAt === null) return;
    if (this.#framesSincePlaced !== null) this.#framesSincePlaced++;
    if ((this.#framesSincePlaced ?? 0) >= 2 || this.now() - this.#shownAt > this.#maxMs) this.lift();
  }

  lift(): void {
    if (this.#shownAt === null) return;
    this.#shownAt = null; this.#framesSincePlaced = null;
    if (!this.el) return;
    this.el.classList.add('is-lifting');
    this.el.setAttribute('aria-busy', 'false');
    const el = this.el;
    const done = (): void => { if (el.classList.contains('is-lifting')) el.hidden = true; };
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 600);
  }
}
