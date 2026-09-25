import { describe, expect, it } from 'vitest';
import { isGrounded } from '../src/narration/grounding.js';

describe('isGrounded', () => {
  it('rejects reversed outcomes without identifiers or numbers', () => {
    expect(isGrounded('A hunt failed — the sambar escaped', 'The tiger killed the sambar and ate it.')).toBe(false);
    expect(isGrounded('Gave birth', 'Not true: Gave birth')).toBe(false);
    expect(isGrounded('Gave birth', 'Gave birth. The calf died.')).toBe(false);
  });
  const template = 'Gave birth to chital_0a3f';

  it('accepts neutral framing around an immutable fact', () => {
    expect(isGrounded(template, 'Observed: Gave birth to chital_0a3f.')).toBe(true);
    expect(isGrounded(template, 'In the long grass, she brought chital_0a3f into the world.')).toBe(false);
  });

  it('rejects a rewording that drops an animal', () => {
    expect(isGrounded(template, 'She gave birth in the long grass.')).toBe(false);
  });

  it('rejects a rewording that brings in an animal the record does not name', () => {
    expect(isGrounded(template, 'She gave birth to chital_0a3f while tiger_0f8b watched.')).toBe(false);
  });

  it('rejects any number the record did not give', () => {
    // "twins", "three days old", "at dawn" — a model inventing a count or time is inventing a fact.
    expect(isGrounded(template, 'She gave birth to chital_0a3f, her 3rd calf.')).toBe(false);
    expect(isGrounded('Ran from danger ×3', 'Observed: Ran from danger ×3.')).toBe(true);
    expect(isGrounded('Ran from danger ×3', 'It ran from danger 4 times.')).toBe(false);
  });

  it('rejects a rewrite that is no longer one short sentence', () => {
    expect(isGrounded(template, `She gave birth to chital_0a3f. ${'The forest was quiet. '.repeat(12)}`)).toBe(false);
    expect(isGrounded(template, '')).toBe(false);
  });
});
