import { mountThemeButton } from './theme.js';

/** What every page shares: the theme switch in the site header. */
const toggle = document.querySelector<HTMLButtonElement>('#theme-toggle');
if (toggle) mountThemeButton(toggle);
