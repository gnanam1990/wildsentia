import { applyTheme, readTheme } from './theme.js';
import { parseChoice } from './themeModel.js';

/**
 * The forest's Settings: one button in the top bar opens the theme, graphics, sound and view
 * options (main.ts wires each control). It closes like any dropdown: a press elsewhere, or Escape,
 * which returns focus to the button.
 */
export function mountSettings(button: HTMLButtonElement, panel: HTMLElement, theme: HTMLSelectElement): void {
  theme.value = readTheme();
  theme.addEventListener('change', () => applyTheme(parseChoice(theme.value)));

  // The panel lives outside the bar (a blurred bar would trap a fixed panel), so it is placed under the button.
  const place = () => {
    const r = button.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.right = `${Math.round(Math.max(12, innerWidth - r.right))}px`;
  };
  const open = (show: boolean, returnFocus = false) => {
    panel.hidden = !show;
    button.setAttribute('aria-expanded', String(show));
    if (show) { place(); theme.focus(); } else if (returnFocus) button.focus();
  };
  button.addEventListener('click', () => open(panel.hidden));
  addEventListener('resize', () => { if (!panel.hidden) place(); });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (!panel.hidden && target && !panel.contains(target) && !button.contains(target)) open(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); open(false, true); }
  }, true);
}
