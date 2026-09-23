import { describe, expect, it } from 'vitest';
import { isGrounded } from '../src/narration/grounding.js';

describe('isGrounded', () => {
  const template = 'Gave birth to chital_0a3f';

  it('accepts a rewording that keeps every animal it names', () => {
    expect(isGrounded(template, 'In the long grass, she brought chital_0a3f into the world.')).toBe(true);
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
    expect(isGrounded('Ran from danger ×3', 'Three times it ran: from danger ×3.')).toBe(true);
    expect(isGrounded('Ran from danger ×3', 'It ran from danger 4 times.')).toBe(false);
  });

  it('rejects a rewrite that is no longer one short sentence', () => {
    expect(isGrounded(template, `She gave birth to chital_0a3f. ${'The forest was quiet. '.repeat(12)}`)).toBe(false);
    expect(isGrounded(template, '')).toBe(false);
  });
});
