/**
 * Where closing a dialog goes back to. A dialog opened from another one (the village list,
 * the event map) returns there; one opened from the forest returns nowhere, so closing it
 * never reopens a dialog the viewer did not come from.
 */
export class ReturnPath {
  #back: (() => void) | null = null;

  /** The way back for this opening, or `null` when it was opened from the forest. */
  openedFrom(back: (() => void) | null): void { this.#back = back; }

  /** Goes back once, if this opening came from somewhere; true when it did. */
  close(): boolean {
    const back = this.#back;
    this.#back = null;
    if (back === null) return false;
    back();
    return true;
  }
}
