import { visualFor } from './species.js';

/** Do not rebuild native select contents on identical live-world notifications. */
export function refreshSpeciesOptions(
  options: Iterable<Pick<HTMLOptionElement, 'value' | 'disabled' | 'textContent'>>,
  population: Record<string, number> | undefined,
): void {
  for (const option of options) {
    if (!option.value) continue;
    const count = population?.[option.value] ?? 0;
    const disabled = count === 0;
    const suffix = visualFor(option.value).model === null ? ' · placeholder' : '';
    const label = `${option.value} (${count})${suffix}`;
    if (option.disabled !== disabled) option.disabled = disabled;
    if (option.textContent !== label) option.textContent = label;
  }
}
