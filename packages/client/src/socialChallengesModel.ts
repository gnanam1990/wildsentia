/** Challenge posts on the social admin page (plan 3c): which step is safe next, and what each status means. */
export type PostAction = 'approve' | 'reject' | 'revoke' | 'publish' | 'redraft' | 'confirm_posted' | 'confirm_not_posted';

export function postActions(status: string, stillTrue: boolean): PostAction[] {
  switch (status) {
    case 'draft': return stillTrue ? ['approve', 'reject'] : ['redraft', 'reject'];
    case 'rejected': case 'revoked': return stillTrue ? ['approve'] : ['redraft'];
    case 'approved': return stillTrue ? ['publish', 'revoke'] : ['redraft', 'revoke'];
    case 'unknown': return ['confirm_posted', 'confirm_not_posted'];
    default: return [];
  }
}

const STATUS: Record<string, string> = {
  draft: 'Waiting for review', approved: 'Approved: not posted yet', rejected: 'Rejected', revoked: 'Approval withdrawn',
  publishing: 'Being posted…', published: 'Posted on X',
  unknown: 'X did not answer clearly: it may or may not have posted. Check X, then say what you found. It is never sent again by itself.',
};
export const postStatus = (s: string) => STATUS[s] ?? s;

/** What the server answered after an action, in words: an unknown X result above all. */
export function actionResult(r: { status?: string; xPostId?: string | null }): string {
  if (r.status === 'unknown') return 'X did not confirm the post. Check X before doing anything else; it is not sent again by itself.';
  if (r.status === 'published') return `Posted on X (post ${r.xPostId}).`;
  return 'Done.';
}

export const ACTION_LABELS: Record<PostAction, string> = { approve: 'Approve', reject: 'Reject', revoke: 'Withdraw approval',
  redraft: 'Write it again from the challenge now',
  publish: 'Post on X now', confirm_posted: 'It is on X (enter the post id)', confirm_not_posted: 'It is not on X' };
