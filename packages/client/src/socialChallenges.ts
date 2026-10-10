import { ACTION_LABELS, actionResult, postActions, postStatus, type PostAction } from './socialChallengesModel.js';

/** The "Challenge posts" section of the social admin page: drafts the server wrote from challenges, for the owner to post or not. */
interface Post { id: string; challengeId: number; kind: string; body: string; status: string; xPostId: string | null; stillTrue: boolean }
type Api = (path: string, body?: object) => Promise<unknown>;
/** False once the tab was locked (or refreshed again): nothing private is drawn after that. */
type IsCurrent = () => boolean;

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

export function clearChallengePosts(): void {
  $('social-challenges-list').replaceChildren();
  $('social-challenges-status').textContent = '';
}

async function act(api: Api, isCurrent: IsCurrent, post: Post, action: PostAction): Promise<void> {
  const say = $('social-challenges-status');
  let result: unknown = null;
  try {
    if (action === 'publish') {
      if (!confirm(`Post this on X now?\n\n${post.body}`)) return;
      result = await api(`/admin/social/challenges/${post.id}/publish`, {});
    } else if (action === 'confirm_posted') {
      const id = prompt('The X post id (the number at the end of the post link):')?.trim();
      if (!id) return;
      result = await api(`/admin/social/challenges/${post.id}/resolve`, { xPostId: id });
    } else if (action === 'confirm_not_posted') {
      if (!confirm('You looked on X and this post is not there? It can then be posted again.')) return;
      result = await api(`/admin/social/challenges/${post.id}/resolve`, { notPosted: true });
    } else result = await api(`/admin/social/challenges/${post.id}/review`, { action });
    if (isCurrent()) say.textContent = actionResult(result as { status?: string; xPostId?: string | null });
  } catch (e) { if (isCurrent()) say.textContent = `Not done: ${(e as Error).message}.`; }
  if (isCurrent()) await loadChallengePosts(api, isCurrent);
}

export async function loadChallengePosts(api: Api, isCurrent: IsCurrent = () => true): Promise<boolean> {
  const say = $('social-challenges-status');
  try {
    const { drafts } = await api('/admin/social/challenges') as { drafts: Post[] };
    if (!isCurrent()) return false;
    $('social-challenges-list').replaceChildren(...drafts.map((post) => {
      const card = document.createElement('article'), head = document.createElement('p'), body = document.createElement('blockquote');
      const state = document.createElement('p'), actions = document.createElement('div');
      card.className = 'social-item';
      head.textContent = `Challenge ${post.challengeId} · ${post.kind}${post.xPostId ? ` · X post ${post.xPostId}` : ''}`;
      body.textContent = post.body;
      state.textContent = `${postStatus(post.status)}${post.stillTrue ? '' : ' · No longer matches the challenge: it cannot be posted.'}`;
      for (const action of postActions(post.status, post.stillTrue)) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = ACTION_LABELS[action];
        b.onclick = () => { b.disabled = true; void act(api, isCurrent, post, action); };
        actions.append(b);
      }
      card.append(head, body, state, actions);
      return card;
    }));
    say.textContent = drafts.length ? `${drafts.length} challenge posts.` : 'No challenge posts yet.';
    return true;
  } catch (e) { if (isCurrent()) say.textContent = `Could not load challenge posts: ${(e as Error).message}.`; return false; }
}
