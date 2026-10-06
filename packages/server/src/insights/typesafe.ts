/**
 * A small client for TypeSafe AI's System One evaluation endpoint (the Jev model).
 *
 * Jev does not write text. It answers typed questions about a state: a Choice from a set of
 * options, a Score on ordered levels, or a Noul (yes/no), each with calibrated probabilities.
 * Wildsentia uses it only for observer insights; nothing it returns reaches the simulation.
 *
 * API: POST {base}/systemone with `Authorization: Bearer <key>`,
 * body { model, state, questions }, answers keyed by question id.
 */

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };

export type Answer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

export interface SystemOneResult { model: string; answers: Record<string, Answer> }
export type SystemOne = (state: unknown, questions: Record<string, Question>) => Promise<SystemOneResult>;

export interface TypeSafeConfig { apiKey: string; baseUrl: string; model: string; timeoutMs: number }

/** Null unless a key is configured: the insights are then simply absent. */
export function typesafeConfig(env: NodeJS.ProcessEnv): TypeSafeConfig | null {
  const apiKey = (env.TYPESAFE_AI_API_KEY ?? env.TYPESAFE_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new Error('TYPESAFE_BASE_URL must be https');
  return { apiKey, baseUrl, model: env.TYPESAFE_MODEL?.trim() || 'jev-latest', timeoutMs: 10_000 };
}

/** Calls allowed per UTC day; an empty or invalid setting keeps the default of 1000. */
export function typesafeDailyCalls(env: NodeJS.ProcessEnv): number {
  const raw = env.TYPESAFE_DAILY_CALLS?.trim();
  if (!raw) return 1000;
  if (!/^[0-9]{1,7}$/.test(raw)) throw new Error('Invalid TYPESAFE_DAILY_CALLS');
  return Number(raw);
}

export class TypeSafeError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); }
}

const finite01 = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const probabilities = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(finite01);

/** Checks an answer against the question it answers; anything else is rejected, not guessed at. */
export function validAnswer(question: Question, answer: unknown): answer is Answer {
  if (typeof answer !== 'object' || answer === null) return false;
  const a = answer as Record<string, unknown>;
  if (a.type !== question.type) return false;
  switch (question.type) {
    case 'choice': return typeof a.choice === 'string' && a.choice in question.criteria
      && probabilities(a.probabilities) && finite01(a.confidence);
    case 'score': return typeof a.score === 'number' && Number.isFinite(a.score)
      && a.score >= 0 && a.score <= question.criteria.length - 1 && probabilities(a.probabilities) && finite01(a.confidence);
    case 'noul': return finite01(a.noul);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function typesafeSystemOne(config: TypeSafeConfig, fetchImpl: typeof fetch = fetch, pause = sleep): SystemOne {
  return async (state, questions) => {
    const body = JSON.stringify({ model: config.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        throw new TypeSafeError(`TypeSafe request failed: ${(error as Error).name}`, null);
      }
      // Rate limited or overloaded: one backed-off retry, then give up for this request.
      if ((response.status === 429 || response.status === 529) && attempt === 0) {
        await pause(1_000 + Math.random() * 500);
        continue;
      }
      if (!response.ok) {
        // The error body is TypeSafe's { message, error_type }; never echo request headers.
        let detail = '';
        try { const e = await response.json() as { error_type?: unknown }; detail = typeof e.error_type === 'string' ? `: ${e.error_type}` : ''; } catch { /* no body */ }
        throw new TypeSafeError(`TypeSafe returned ${response.status}${detail}`, response.status);
      }
      const json = await response.json() as { model?: unknown; answers?: unknown };
      if (typeof json.answers !== 'object' || json.answers === null) throw new TypeSafeError('TypeSafe response had no answers', response.status);
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = (json.answers as Record<string, unknown>)[id];
        if (!validAnswer(question, answer)) throw new TypeSafeError(`TypeSafe answer ${id} did not match its question`, response.status);
        answers[id] = answer;
      }
      return { model: typeof json.model === 'string' ? json.model : config.model, answers };
    }
  };
}
