import { describe, expect, it, vi } from 'vitest';
import { createXPublisher, sameTextIgnoringLinks } from '../src/xPublisher.js';

describe('X transport boundary', () => {
  it('sends only the text-only create shape and validates the X response', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { id: '123', text: 'Grounded event.' } }),
      { status: 201 }));
    const publisher = createXPublisher('456', 'fixture-token', request);
    expect(await publisher.create('Grounded event.')).toEqual({ id: '123', text: 'Grounded event.' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.x.com/2/tweets');
    expect(init).toMatchObject({ method: 'POST', headers: {
      Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ text: 'Grounded event.' }) });
    expect(JSON.stringify({ url, body: init?.body })).not.toContain('fixture-token');
  });

  it('rejects mismatched create results and verifies a read-only lookup shape', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
      ? new Response(JSON.stringify({ data: { id: '123', text: 'Different text' } }), { status: 201 })
      : new Response(JSON.stringify({ data: { id: '123', text: 'Grounded event.', author_id: '456' } }), { status: 200 }));
    const publisher = createXPublisher('456', 'fixture-token', request);
    await expect(publisher.create('Grounded event.')).rejects.toThrow();
    expect(await publisher.lookup('123')).toEqual({ id: '123', text: 'Grounded event.', authorId: '456' });
    expect(request.mock.calls[1]![0]).toBe('https://api.x.com/2/tweets/123?tweet.fields=author_id');
    expect(request.mock.calls[1]![1]?.method).toBe('GET');
    await expect(publisher.lookup('not-an-id')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('checks the exact token account before the caller permits a create', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { id: '789' } }),
      { status: 200 }));
    const publisher = createXPublisher('456', 'fixture-token', request);
    await expect(publisher.verifyAccount()).rejects.toThrow('different account');
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe('https://api.x.com/2/users/me');
    expect(request.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('accepts the text X returns with its links rewritten to t.co, and nothing else', async () => {
    const sent = 'Challenge 7 was won. https://wildsentia.lol/challenges.html?id=7';
    const back = 'Challenge 7 was won. https://t.co/AbC123xyz';
    expect(sameTextIgnoringLinks(sent, back)).toBe(true);
    expect(sameTextIgnoringLinks(sent, 'Challenge 8 was won. https://t.co/AbC123xyz')).toBe(false);
    expect(sameTextIgnoringLinks('No link.', 'No link.')).toBe(true);
    expect(sameTextIgnoringLinks(sent, 'Challenge 7 was won.')).toBe(false);
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { id: '9', text: back } }), { status: 201 }));
    expect(await createXPublisher('456', 'fixture-token', request).create(sent)).toEqual({ id: '9', text: sent });
  });
});
