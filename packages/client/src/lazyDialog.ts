/** Load a non-scene observer dialog only when requested; failed imports remain retryable. */
export class LazyDialog<Args extends unknown[]> {
  #ready: ((...args: Args) => void) | null = null;
  #pending: Promise<(...args: Args) => void> | null = null;
  #opening = false;

  constructor(
    private readonly label: string,
    private readonly status: HTMLElement,
    private readonly load: () => Promise<(...args: Args) => void>,
  ) {}

  async open(...args: Args): Promise<boolean> {
    if (this.#opening) return false;
    this.#opening = true;
    const loading = `Opening ${this.label}…`;
    if (!this.#ready) this.status.textContent = loading;
    try {
      const open = this.#ready ?? await (this.#pending ??= this.load().catch((error: unknown) => {
        this.#pending = null;
        throw error;
      }));
      this.#ready = open;
      if (this.status.textContent === loading) this.status.textContent = '';
      open(...args);
      return true;
    } catch {
      this.status.textContent = `${this.label} unavailable. Try opening it again.`;
      return false;
    } finally {
      this.#opening = false;
    }
  }
}
