/** The viewer's colour theme: light unless they pick dark, or their device's own setting. */
export type ThemeChoice = 'auto' | 'light' | 'dark';

/** Where the pick is kept (public/theme-init.js reads the same key before the page paints). */
export const THEME_KEY = 'wildsentia-theme';

export const parseChoice = (value: unknown): ThemeChoice => (value === 'dark' || value === 'auto' ? value : 'light');

const ORDER: ThemeChoice[] = ['light', 'dark', 'auto'];
export const nextChoice = (choice: ThemeChoice): ThemeChoice => ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]!;

export const themeLabel = (choice: ThemeChoice): string => (choice === 'auto' ? 'Theme: same as device' : `Theme: ${choice}`);
