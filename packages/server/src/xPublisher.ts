/** Network boundary for a single X create, and a read-only lookup for uncertain outcomes. */
export interface XPublisher {
  accountId: string;
  verifyAccount(): Promise<void>;
  create(text: string): Promise<{ id: string; text: string }>;
  lookup(id: string): Promise<{ id: string; text: string; authorId: string } | null>;
}

export function createXPublisher(accountId: string, token: string, request: typeof fetch = fetch): XPublisher {
  if (!/^[0-9]{1,30}$/.test(accountId) || !token || /\s/.test(token)) throw new Error('Invalid X publisher configuration');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    accountId,
    async verifyAccount() {
      const response = await request('https://api.x.com/2/users/me', {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) throw new Error('X account lookup unavailable');
      const data: unknown = await response.json();
      if ((data as { data?: { id?: unknown } })?.data?.id !== accountId)
        throw new Error('X user token belongs to a different account');
    },
    async create(text) {
      const response = await request('https://api.x.com/2/tweets', {
        method: 'POST', headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 201) throw new Error('X create did not return 201');
      const data: unknown = await response.json();
      const post = (data as { data?: { id?: unknown; text?: unknown } })?.data;
      if (typeof post?.id !== 'string' || !/^[0-9]{1,30}$/.test(post.id) || post.text !== text)
        throw new Error('X create response did not match prepared text');
      return { id: post.id, text };
    },
    async lookup(id) {
      if (!/^[0-9]{1,30}$/.test(id)) throw new Error('Invalid X post ID');
      const response = await request(`https://api.x.com/2/tweets/${id}?tweet.fields=author_id`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error('X lookup unavailable');
      const data: unknown = await response.json();
      const post = (data as { data?: { id?: unknown; text?: unknown; author_id?: unknown } })?.data;
      if (post?.id !== id || typeof post.text !== 'string' || typeof post.author_id !== 'string')
        throw new Error('Invalid X lookup response');
      return { id, text: post.text, authorId: post.author_id };
    },
  };
}
