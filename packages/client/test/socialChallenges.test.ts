import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { postActions, postStatus } from '../src/socialChallengesModel.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('challenge posts on the social admin page', () => {
  it('has its own section, loaded with the rest and cleared when the tab locks', () => {
    const html = read('social-admin.html');
    for (const id of ['social-challenges', 'social-challenges-status', 'social-challenges-list']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('href="#social-challenges"');
    const admin = read('src/socialAdmin.ts');
    expect(admin).toMatch(/loadChallengePosts\(/);
    expect(admin).toMatch(/clearChallengePosts\(/);
    expect(read('src/socialChallenges.ts')).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('offers only the next safe step for each post', () => {
    expect(postActions('draft', true)).toEqual(['approve', 'reject']);
    expect(postActions('draft', false)).toEqual(['reject']);
    expect(postActions('approved', true)).toEqual(['publish', 'revoke']);
    expect(postActions('approved', false)).toEqual(['revoke']);
    expect(postActions('rejected', true)).toEqual(['approve']);
    expect(postActions('unknown', true)).toEqual(['confirm_posted', 'confirm_not_posted']);
    expect(postActions('published', true)).toEqual([]);
    expect(postActions('publishing', true)).toEqual([]);
  });

  it('says what each status means', () => {
    expect(postStatus('unknown')).toMatch(/Check X/);
    expect(postStatus('published')).toBe('Posted on X');
    expect(postStatus('draft')).toBe('Waiting for review');
  });
});
