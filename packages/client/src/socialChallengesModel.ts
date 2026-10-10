/** Challenge posts on the social admin page (plan 3c): which step is safe next, and what each status means. */
export type PostAction = 'approve' | 'reject' | 'revoke' | 'publish' | 'confirm_posted' | 'confirm_not_posted';

export function postActions(status: string, stillTrue: boolean): PostAction[] {
  switch (status) {
    case 'draft': return stillTrue ? ['approve', 'reject'] : ['reject'];
    case 'rejected': case 'revoked': return stillTrue ? ['approve'] : [];
    case 'approved': return stillTrue ? ['publish', 'revoke'] : ['revoke'];
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

export const ACTION_LABELS: Record<PostAction, string> = { approve: 'Approve', reject: 'Reject', revoke: 'Withdraw approval',
  publish: 'Post on X now', confirm_posted: 'It is on X (enter the post id)', confirm_not_posted: 'It is not on X' };
