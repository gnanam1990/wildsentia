import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_KEY, nextChoice, parseChoice, themeLabel } from '../src/themeModel.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PAGES = ['index.html', 'challenges.html', 'play.html', 'challenge-new.html', 'connect.html', 'holder.html'];

describe('theme', () => {
  it('is light unless the viewer picked dark or their device setting, and cycles through all three', () => {
    expect(['light', 'dark', 'auto', null, 'blue', ''].map(parseChoice)).toEqual(['light', 'dark', 'auto', 'light', 'light', 'light']);
    expect(nextChoice('light')).toBe('dark');
    expect(nextChoice('dark')).toBe('auto');
    expect(nextChoice('auto')).toBe('light');
    expect(themeLabel('auto')).toBe('Theme: same as device');
    expect(themeLabel('light')).toBe('Theme: light');
    expect(themeLabel('dark')).toBe('Theme: dark');
  });

  it('is applied before any page paints, from a script that never breaks a page without storage', () => {
    for (const page of PAGES) {
      const html = read(page);
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head, page).toContain('<script src="/theme-init.js"></script>');
      expect(head.indexOf('theme-init.js'), page).toBeLessThan(head.indexOf('stylesheet'));
    }
    const init = read('public/theme-init.js');
    expect(init).toContain(THEME_KEY);
    expect(init).toMatch(/try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
    // With nothing saved, or storage blocked, the page is light.
    expect(init).toMatch(/var choice = 'light';/);
  });

  it('has a light palette for every colour the pages use, chosen or from the device', () => {
    const css = read('src/style.css');
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{/);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme="dark"\]\)\s*\{/);
    const tokens = [...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!);
    const dark = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const light = css.slice(css.indexOf(':root[data-theme="light"]'), css.indexOf('}', css.indexOf(':root[data-theme="light"]')));
    const colours = [...dark.matchAll(/(--[a-z0-9-]+):\s*(#|rgba?\()/g)].map((m) => m[1]!);
    expect(colours.length).toBeGreaterThan(10);
    for (const token of colours) expect(light, token).toContain(`${token}:`);
    expect(tokens).toContain('--bg');
  });

  it('keeps page styles on the palette instead of fixed dark colours', () => {
    for (const sheet of ['src/holder.css', 'src/challenges.css', 'src/play.css', 'src/connect.css'])
      expect(read(sheet), sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe('site header', () => {
  const NAV: Array<[string, string]> = [['/', 'Forest'], ['/challenges.html', 'Challenges'], ['/play.html', 'Play'], ['/connect.html', 'AI agents']];
  const CURRENT: Record<string, string> = { 'challenges.html': '/challenges.html', 'challenge-new.html': '/challenges.html', 'play.html': '/play.html',
    'connect.html': '/connect.html', 'holder.html': '' };

  it('is the same on every page: the brand leads home, the four places are named, the current one is marked, and the theme switch is there', () => {
    for (const [page, current] of Object.entries(CURRENT)) {
      const html = read(page);
      const header = html.slice(html.indexOf('<header class="site-header">'), html.indexOf('</header>'));
      expect(header, page).toContain('<a class="brand" href="/">');
      for (const [href, label] of NAV) expect(header, `${page} ${label}`).toMatch(new RegExp(`<a [^>]*href="${href.replace('.', '\\.')}"[^>]*>${label}</a>`));
      const marked = [...header.matchAll(/<a [^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
      expect(marked, page).toEqual(current ? [current] : []);
      expect(header, page).toContain('id="theme-toggle"');
    }
    // Every page script mounts the switch.
    for (const script of ['challenges', 'play', 'challengeNew', 'connect', 'holder'])
      expect(read(`src/${script}.ts`), script).toContain("import './pageChrome.js';");
  });
});

describe('forest settings', () => {
  it('gathers theme, graphics, sound and view options behind one Settings button in the top bar', () => {
    const html = read('index.html');
    const actions = html.slice(html.indexOf('class="bar-actions"'), html.indexOf('</header>'));
    expect(actions).toMatch(/<button id="open-settings" type="button" aria-expanded="false" aria-controls="settings-panel"/);
    const panel = html.slice(html.indexOf('id="settings-panel"'), html.indexOf('</section>', html.indexOf('id="settings-panel"')));
    for (const id of ['theme-choice', 'render-quality', 'ambient-toggle', 'observer-cutaway']) expect(panel, id).toContain(`id="${id}"`);
    const passport = html.slice(html.indexOf('id="passport-panel"'), html.indexOf('</aside>', html.indexOf('id="passport-panel"')));
    expect(passport).not.toContain('render-quality');
    expect(read('src/main.ts')).toContain("mountSettings(");
    const settings = read('src/settings.ts');
    expect(settings).toContain("'Escape'");
    expect(settings).toContain('pointerdown');
    expect(settings).toContain('applyTheme(');
  });
});

describe('forest friendliness', () => {
  it('hides what does not apply: no rewards pill when rewards are off, no empty "while you were away" card', () => {
    expect(read('src/rewards.ts')).toMatch(/response\.status === 503\)[\s\S]{0,200}this\.#total\.hidden = true/);
    const hud = read('src/hud.ts');
    expect(hud).not.toContain('No narrated significant events');
    expect(hud).toMatch(/if \(r === null \|\| r\.id !== id \|\| r\.lines\.length === 0\) return '';/);
  });

  it('keeps labels drawn over the forest readable in either theme', () => {
    const css = read('src/style.css');
    for (const rule of ['.encounter-label {', '.footer {']) {
      const at = css.indexOf(rule), body = css.slice(at, css.indexOf('}', at));
      expect(body, rule).not.toMatch(/var\(--ink|var\(--text-glow/);
    }
  });
});
