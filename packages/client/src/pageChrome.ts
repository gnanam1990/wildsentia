import { mountThemeButton } from './theme.js';

/** What every page shares: the theme switch in the site header. (Tests import pages without a DOM.) */
const toggle = typeof document === 'undefined' ? null : document.querySelector<HTMLButtonElement>('#theme-toggle');
if (toggle) mountThemeButton(toggle);
