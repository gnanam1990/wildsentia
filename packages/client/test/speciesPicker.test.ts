import { expect, it, vi } from 'vitest';
import { refreshSpeciesOptions } from '../src/speciesPicker.js';

it('leaves native select options untouched when live counts are unchanged', () => {
  const option = { value: 'tiger', disabled: false, textContent: 'tiger (4)' };
  const writes = vi.fn();
  const observed = new Proxy(option, { set(target, key, value) {
    writes(key, value); Reflect.set(target, key, value); return true;
  } });
  refreshSpeciesOptions([observed], { tiger: 4 });
  refreshSpeciesOptions([observed], { tiger: 4 });
  expect(writes).not.toHaveBeenCalled();
  refreshSpeciesOptions([observed], { tiger: 3 });
  expect(writes.mock.calls).toEqual([['textContent', 'tiger (3)']]);
});

it('updates availability and placeholders while preserving the prompt', () => {
  const prompt = { value: '', disabled: false, textContent: 'Choose an animal' };
  const tiger = { value: 'tiger', disabled: false, textContent: 'tiger (4)' };
  const unknown = { value: 'unknown', disabled: true, textContent: '' };
  refreshSpeciesOptions([prompt, tiger, unknown], { unknown: 2 });
  expect(prompt.textContent).toBe('Choose an animal');
  expect(tiger).toMatchObject({ disabled: true, textContent: 'tiger (0)' });
  expect(unknown).toMatchObject({ disabled: false, textContent: 'unknown (2) · placeholder' });
  refreshSpeciesOptions([tiger], { tiger: 1 });
  expect(tiger.disabled).toBe(false);
});
