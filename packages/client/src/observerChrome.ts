/** Viewer-only panels. A narrow screen shows one sheet at a time. */
export function initObserverChrome(onCenter?: (centerY: number | null) => void): { showAnimal: () => void; setReplaying: (active: boolean) => void; setCinema: (active: boolean) => void } {
  const compact = matchMedia('(max-width: 860px)');
  const journal = document.querySelector<HTMLElement>('#feed-panel')!;
  const animal = document.querySelector<HTMLElement>('#passport-panel')!;
  const settings = document.querySelector<HTMLElement>('#view-settings')!;
  const journalButton = document.querySelector<HTMLButtonElement>('#toggle-journal')!;
  const animalButton = document.querySelector<HTMLButtonElement>('#toggle-animal')!;
  const settingsButton = document.querySelector<HTMLButtonElement>('#toggle-settings')!;
  const clearButton = document.querySelector<HTMLButtonElement>('#clear-view')!;
  let journalOpen = !compact.matches;
  let side: 'animal' | 'settings' | null = 'animal';
  let clear = false;
  let replaying = false;
  let cinema = false;
  let measureFrame = 0;

  function measure(): void {
    measureFrame = 0;
    const sheet = [animal, journal, settings].find(panel => !panel.hidden);
    if (cinema || !compact.matches || !sheet) { onCenter?.(null); return; }
    const top = document.querySelector('.world-glance')!.getBoundingClientRect().bottom + 12;
    const bottom = sheet.getBoundingClientRect().top;
    // Keep the observed subject in the visible forest above a narrow-screen sheet.
    onCenter?.(bottom - top >= 80 ? (top + bottom) / 2 : null);
  }
  function scheduleMeasure(): void {
    if (!measureFrame) measureFrame = requestAnimationFrame(measure);
  }

  function render(): void {
    journal.hidden = replaying || clear || !journalOpen;
    animal.hidden = replaying || clear || side !== 'animal';
    settings.hidden = replaying || clear || side !== 'settings';
    for (const button of [journalButton, animalButton, settingsButton, clearButton]) button.disabled = replaying;
    journalButton.setAttribute('aria-expanded', String(!journal.hidden));
    animalButton.setAttribute('aria-expanded', String(!animal.hidden));
    settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
    clearButton.setAttribute('aria-pressed', String(clear));
    clearButton.title = clear ? 'Restore observer panels' : 'Hide panels for a clear view';
    document.body.classList.toggle('clear-view', clear);
    scheduleMeasure();
  }
  function showSide(next: typeof side): void {
    side = next; clear = false;
    if (compact.matches && next) journalOpen = false;
    render();
  }
  journalButton.addEventListener('click', () => {
    journalOpen = journal.hidden; clear = false;
    if (compact.matches && journalOpen) side = null;
    render();
  });
  animalButton.addEventListener('click', () => showSide(animal.hidden ? 'animal' : null));
  settingsButton.addEventListener('click', () => {
    showSide(settings.hidden ? 'settings' : 'animal');
    if (!settings.hidden) settings.querySelector<HTMLButtonElement>('[data-close-panel]')!.focus();
  });
  clearButton.addEventListener('click', () => { clear = !clear; render(); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close-panel]')) {
    button.addEventListener('click', () => {
      const panel = button.dataset.closePanel;
      if (panel === 'journal') { journalOpen = false; render(); journalButton.focus(); }
      else { showSide(panel === 'settings' ? 'animal' : null); (panel === 'settings' ? settingsButton : animalButton).focus(); }
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (clear) { clear = false; render(); clearButton.focus(); }
    else if (!settings.hidden) { showSide('animal'); settingsButton.focus(); }
  });
  compact.addEventListener('change', () => {
    journalOpen = !compact.matches;
    render();
  });
  const geometry = new ResizeObserver(scheduleMeasure);
  for (const element of [animal, journal, settings, document.querySelector('.bar')!, document.querySelector('#view')!]) geometry.observe(element);
  addEventListener('resize', scheduleMeasure);
  render();
  return {
    showAnimal: () => showSide('animal'),
    setReplaying: active => { replaying = active; render(); },
    setCinema: active => { cinema = active; scheduleMeasure(); },
  };
}
