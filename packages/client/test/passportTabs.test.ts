import { describe, expect, it } from 'vitest';
import { PASSPORT_TABS, PassportTabs } from '../src/passportTabs.js';

/** Minimal DOM boundary: simulate replaced nodes, focus and event delegation without a browser dependency. */
function inspector() {
  const listeners = new Map<string, (event: unknown) => void>();
  const document = { activeElement: null as TestElement | null };
  type TestElement = {
    dataset: Record<string, string>; tabIndex: number; hidden: boolean; scrollTop: number;
    attributes: Record<string, string>; focus(): void; setAttribute(name: string, value: string): void;
    closest(): TestElement;
  };
  const node = (dataset: Record<string, string>): TestElement => {
    const element: TestElement = { dataset, tabIndex: -1, hidden: false, scrollTop: 0, attributes: {},
      focus() { document.activeElement = element; },
      setAttribute(name, value) { element.attributes[name] = value; }, closest() { return element; } };
    return element;
  };
  let tabs: TestElement[] = [], panels: TestElement[] = [], actions: TestElement[] = [];
  let html = '', writes = 0;
  const root = {
    ownerDocument: document, scrollTop: 0,
    addEventListener(name: string, handler: (event: unknown) => void) { listeners.set(name, handler); },
    contains(element: TestElement) { return [...tabs, ...panels, ...actions].includes(element); },
    querySelectorAll(selector: string) {
      return selector === '[data-passport-tab]' ? tabs : selector === '[data-passport-panel]' ? panels : [...tabs, ...panels, ...actions];
    },
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value; writes++; document.activeElement = null;
      tabs = PASSPORT_TABS.map(tab => node({ passportTab: tab, passportFocus: `tab:${tab}` }));
      panels = PASSPORT_TABS.map(tab => node({ passportPanel: tab, passportFocus: `panel:${tab}` }));
      actions = [node({ passportFocus: 'history' })];
    },
  };
  const controller = new PassportTabs(root as unknown as HTMLElement);
  return {
    controller, root, document,
    get tabs() { return tabs; }, get panels() { return panels; }, get actions() { return actions; }, get writes() { return writes; },
    click(index: number) { listeners.get('click')?.({ target: tabs[index] }); },
    key(index: number, key: string) {
      let prevented = false;
      listeners.get('keydown')?.({ target: tabs[index], key, preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

describe('animal inspector tabs', () => {
  it('supports arrow, Home and End navigation with a single tab stop and matching visible panel', () => {
    const view = inspector();
    view.controller.render('boar_1', 'first checkpoint');
    expect(view.tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(view.panels.map(panel => panel.hidden)).toEqual([false, true, true]);
    view.click(1);
    expect(view.tabs.map(tab => tab.attributes['aria-selected'])).toEqual(['false', 'true', 'false']);
    expect(view.panels.map(panel => panel.hidden)).toEqual([true, false, true]);
    expect(view.key(1, 'ArrowRight')).toBe(true);
    expect(view.document.activeElement).toBe(view.tabs[2]);
    expect(view.key(2, 'ArrowRight')).toBe(true);
    expect(view.document.activeElement).toBe(view.tabs[0]);
    view.key(0, 'ArrowLeft');
    expect(view.document.activeElement).toBe(view.tabs[2]);
    view.key(2, 'Home');
    expect(view.document.activeElement).toBe(view.tabs[0]);
    view.key(0, 'End');
    expect(view.document.activeElement).toBe(view.tabs[2]);
    expect(view.tabs.map(tab => tab.tabIndex)).toEqual([-1, -1, 0]);
    expect(view.key(2, 'Tab')).toBe(false);
  });

  it('retains tab, focus and scroll through a changed checkpoint and leaves identical DOM intact', () => {
    const view = inspector();
    view.controller.render('boar_1', 'first checkpoint');
    view.key(0, 'End');
    view.panels[2]!.scrollTop = 80;
    const originalTab = view.tabs[2];
    view.controller.render('boar_1', 'first checkpoint');
    expect(view.writes).toBe(1);
    expect(view.document.activeElement).toBe(originalTab);
    view.controller.render('boar_1', 'updated checkpoint');
    expect(view.tabs[2]).not.toBe(originalTab);
    expect(view.document.activeElement).toBe(view.tabs[2]);
    expect(view.panels.map(panel => panel.hidden)).toEqual([true, true, false]);
    expect(view.panels[2]!.scrollTop).toBe(80);
    view.actions[0]!.focus();
    view.controller.render('boar_1', 'another checkpoint');
    expect(view.document.activeElement).toBe(view.actions[0]);
    view.controller.render('boar_2', 'another checkpoint');
    expect(view.panels.map(panel => panel.hidden)).toEqual([false, true, true]);
    expect(view.panels[2]!.scrollTop).toBe(0);
    expect(view.document.activeElement).toBeNull();
  });
});
