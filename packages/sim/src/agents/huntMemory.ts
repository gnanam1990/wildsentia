import type { Agent } from '@vana/shared';

// Simulation policy, not a claimed field measurement. A bounded, short memory lets a predator
// seek another opportunity after giving up, without permanently blacklisting a living animal.
export const FAILED_HUNT_RETRY_SECONDS = 6 * 3600;
export const MAX_FAILED_HUNT_MEMORIES = 16;

export function canRetryPrey(agent: Agent, preyId: string, at: number): boolean {
  return !(agent.failedHunts ?? []).some((m) => m.preyId === preyId && m.retryAfter > at);
}

export function rememberFailedHunt(agent: Agent, preyId: string, at: number): void {
  agent.failedHunts = [...(agent.failedHunts ?? []).filter((m) => m.retryAfter > at && m.preyId !== preyId),
    { preyId, retryAfter: at + FAILED_HUNT_RETRY_SECONDS }].slice(-MAX_FAILED_HUNT_MEMORIES);
}
