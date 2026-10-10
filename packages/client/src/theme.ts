import { THEME_KEY, nextChoice, parseChoice, themeLabel, type ThemeChoice } from './themeModel.js';

/** The viewer's saved pick; light when there is none, or storage is blocked. */
export function readTheme(): ThemeChoice {
  try { return parseChoice(localStorage.getItem(THEME_KEY)); } catch { return 'light'; }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch { /* the pick lasts for this page only */ }
}

const ICON: Record<ThemeChoice, string> = {
  auto: '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
};

/** Turns a button into the theme switch: each press moves light → dark → same as device → light. */
export function mountThemeButton(button: HTMLButtonElement, onChange?: (choice: ThemeChoice) => void): void {
  let choice = readTheme();
  const show = () => {
    // Fixed icons, never server text.
    button.innerHTML = `${ICON[choice]}<span class="sr-only">${themeLabel(choice)}</span>`;
    button.title = `${themeLabel(choice)} (press to change)`;
  };
  show();
  button.addEventListener('click', () => {
    choice = nextChoice(choice);
    applyTheme(choice);
    show();
    onChange?.(choice);
  });
}
