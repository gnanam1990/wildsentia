export const PASSPORT_TABS = ['overview', 'life', 'record'] as const;
export type PassportTab = typeof PASSPORT_TABS[number];

const isTab = (value: string | undefined): value is PassportTab =>
  PASSPORT_TABS.some(tab => tab === value);

/** Keeps reading position and keyboard navigation independent of world updates. */
export class PassportTabs {
  #subject: string | null = null;
  #selected: PassportTab = 'overview';
  #html = '';

  constructor(private readonly root: HTMLElement) {
    root.addEventListener?.('click', event => {
      const tab = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-passport-tab]');
      if (tab && root.contains(tab) && isTab(tab.dataset.passportTab)) this.#select(tab.dataset.passportTab);
    });
    root.addEventListener?.('keydown', event => {
      const tab = (event.target as Element | null)?.closest?.<HTMLButtonElement>('[data-passport-tab]');
      if (!tab || !root.contains(tab) || !isTab(tab.dataset.passportTab)) return;
      const index = PASSPORT_TABS.indexOf(tab.dataset.passportTab);
      const next = event.key === 'ArrowRight' ? PASSPORT_TABS[(index + 1) % PASSPORT_TABS.length]
        : event.key === 'ArrowLeft' ? PASSPORT_TABS[(index + PASSPORT_TABS.length - 1) % PASSPORT_TABS.length]
          : event.key === 'Home' ? 'overview' : event.key === 'End' ? 'record' : null;
      if (next) { event.preventDefault(); this.#select(next, true); }
    });
  }

  #select(tab: PassportTab, focus = false): void {
    this.#selected = tab;
    for (const button of this.root.querySelectorAll?.<HTMLButtonElement>('[data-passport-tab]') ?? []) {
      const active = button.dataset.passportTab === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus({ preventScroll: true });
    }
    for (const panel of this.root.querySelectorAll?.<HTMLElement>('[data-passport-panel]') ?? []) {
      panel.hidden = panel.dataset.passportPanel !== tab;
    }
  }

  render(subject: string | null, html: string): void {
    const sameSubject = this.#subject === subject;
    if (!sameSubject) this.#selected = 'overview';
    this.#subject = subject;
    if (sameSubject && html === this.#html) return;
    const focused = this.root.ownerDocument?.activeElement as HTMLElement | null | undefined;
    const hadFocus = sameSubject && focused && this.root.contains?.(focused);
    const focusKey = hadFocus ? focused.dataset.passportFocus : undefined;
    const scroll = sameSubject ? this.root.scrollTop : 0;
    const panelScroll = new Map(Array.from(this.root.querySelectorAll?.<HTMLElement>('[data-passport-panel]') ?? [])
      .map(panel => [panel.dataset.passportPanel, sameSubject ? panel.scrollTop : 0]));
    this.root.innerHTML = html;
    this.#html = html;
    this.#select(this.#selected);
    this.root.scrollTop = scroll;
    for (const panel of this.root.querySelectorAll?.<HTMLElement>('[data-passport-panel]') ?? []) {
      panel.scrollTop = panelScroll.get(panel.dataset.passportPanel) ?? 0;
    }
    if (hadFocus) {
      const targets = Array.from(this.root.querySelectorAll?.<HTMLElement>('[data-passport-focus]') ?? []);
      const target = targets.find(element => element.dataset.passportFocus === focusKey)
        ?? targets.find(element => element.dataset.passportFocus === `tab:${this.#selected}`);
      target?.focus({ preventScroll: true });
    }
  }
}
