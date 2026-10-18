import { speciesGroups } from './animalBrowserModel.js';

export interface PickerGroup { label: string; options: Array<{ value: string; label: string }> }

/** The species picker's options: this world's living species by kind, each with its count. */
export function pickerGroups(population: Readonly<Record<string, number>> | undefined): PickerGroup[] {
  return speciesGroups(population).map((g) => ({
    label: g.label, options: g.species.map((s) => ({ value: s.id, label: `${s.name} (${s.count.toLocaleString('en-US')})` })),
  }));
}

/**
 * Fills the native select from `pickerGroups`. Rebuilt only when the species on offer change; on
 * a live-count update only the labels that changed are written, so an open list is not disturbed.
 */
export function renderSpeciesPicker(select: HTMLSelectElement, population: Readonly<Record<string, number>> | undefined): void {
  const groups = pickerGroups(population);
  const signature = groups.map((g) => `${g.label}:${g.options.map((o) => o.value).join(',')}`).join('|');
  if (select.dataset.species !== signature) {
    const chosen = select.value, prompt = select.options[0]!;
    select.replaceChildren(prompt, ...groups.map((g) => {
      const group = document.createElement('optgroup'); group.label = g.label;
      group.append(...g.options.map((o) => { const option = document.createElement('option'); option.value = o.value; option.textContent = o.label; return option; }));
      return group;
    }));
    select.dataset.species = signature;
    select.value = groups.some((g) => g.options.some((o) => o.value === chosen)) ? chosen : '';
    return;
  }
  const labels = new Map(groups.flatMap((g) => g.options.map((o) => [o.value, o.label] as const)));
  for (const option of select.options) {
    const label = labels.get(option.value);
    if (label !== undefined && option.textContent !== label) option.textContent = label;
  }
}
