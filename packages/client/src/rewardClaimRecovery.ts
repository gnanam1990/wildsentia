export type ClaimRecovery = 'renew_selection' | 'retry_exact' | 'correct_input' | 'refresh_reward' | 'wait' | 'stop';

/** Never renew an anonymous identity after an uncertain earlier claim; that identity may own a reservation. */
export function claimRecovery(status: number | undefined, earlierUncertain: boolean): ClaimRecovery {
  if (earlierUncertain && [400, 401, 404, 409].includes(status ?? -1)) return 'stop';
  if (status === 401) return 'renew_selection';
  if (status === 400) return 'correct_input';
  if (status === 404 || status === 409) return 'refresh_reward';
  if (status === 429) return 'wait';
  return 'retry_exact';
}
