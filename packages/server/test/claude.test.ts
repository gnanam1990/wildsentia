import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeRephraser } from '../src/narration/claude.js';

describe('claudeRephraser', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is absent without credentials, so the narrator tells everything by template', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    expect(claudeRephraser()).toBeNull();
  });

  it('is present when a server API key is configured', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    expect(typeof claudeRephraser()).toBe('function');
  });
});
