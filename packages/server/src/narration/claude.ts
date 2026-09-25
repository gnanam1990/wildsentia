import Anthropic from '@anthropic-ai/sdk';
import type { Rephraser } from './narrator.js';

const MODEL = 'claude-opus-5';

/**
 * Stable across every call, so it caches: the whole of what the model is allowed to do.
 * It rewords; it never adds. The grounding check enforces what this asks for.
 */
const SYSTEM = `The supplied line is an immutable fact from a simulated animal's life record.
Return the exact line unchanged, optionally preceded by exactly one neutral prefix:
"Life record: ", "Observed: ", or "From the record: ".
Do not rewrite, omit or add facts, words, identifiers or numbers. Output the line only.`;

/**
 * The model behind the narrator. It sees one template line and returns a rewording; it has no
 * tools and no path to the simulation. Returns null when no credentials are configured, and the
 * narrator then tells everything by template.
 */
export function claudeRephraser(): Rephraser | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic();

  return async (template) => {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      // Rewording one line is simple work; low effort keeps it quick and cheap.
      output_config: { effort: 'low' },
      // If a line is ever declined, the API retries it on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: template }],
    });
    const tokens = response.usage.input_tokens + response.usage.output_tokens;
    if (response.stop_reason === 'refusal') return { text: '', tokens, model: response.model };
    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    return { text, tokens, model: response.model };
  };
}
