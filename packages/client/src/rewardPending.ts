export interface PendingAllocation {
  id: string; actorId: string; amount: string; revealWhen: string;
}

/** An ID alone is insufficient proof that an uncertain allocation has the intended terms. */
export function pendingAllocationMatch(pending: PendingAllocation | null,
  drops: readonly { id: string; actorId: string; amount: string; network: string; revealWhen: string }[],
): 'absent' | 'exact' | 'conflict' {
  if (!pending) return 'absent';
  const found = drops.find((drop) => drop.id === pending.id);
  if (!found) return 'absent';
  const parsed = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]{1,6}))?$/.exec(pending.amount);
  const normalized = parsed ? `${parsed[1]}.${(parsed[2] ?? '').padEnd(6, '0')}` : null;
  return found.actorId === pending.actorId && found.amount === normalized
    && found.revealWhen === pending.revealWhen && found.network === 'base' ? 'exact' : 'conflict';
}

/** A late failure must not revoke access acquired with a newer administrator token. */
export function shouldLockRewardAdmin(status: number, requestToken: string, currentToken: string): boolean {
  return status === 401 && requestToken.length > 0 && currentToken === requestToken;
}
