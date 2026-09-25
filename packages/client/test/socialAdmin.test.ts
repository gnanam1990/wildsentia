import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyPage, exportAuditFacts, exportDocument, newerPage, olderPage, reviewActions, sections, worldClock,
  type Draft, type ExportAuditEntry } from '../src/socialAdminModel.js';

const source = readFileSync(new URL('../src/socialAdmin.ts', import.meta.url), 'utf8');
const html = readFileSync(new URL('../social-admin.html', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

describe('separate local social administration journey', () => {
  it('has an independent Vite page and accessible controls for all five paginated sections', () => {
    expect(vite).toContain("socialAdmin: 'social-admin.html'");
    expect(html).toContain('src="/src/socialAdmin.ts"');
    expect(html).toContain('id="social-token" type="password"');
    for (const kind of sections) {
      for (const suffix of ['list', 'status', 'newer', 'older', 'page'])
        expect(html).toContain(`id="social-${kind}-${suffix}"`);
    }
    expect(source).toContain('`/admin/social/${kind}');
    expect(sections).toContain('export-audit');
    expect(source).toContain("results.push(await load('export-audit'))");
    expect(html).toContain('id="social-review-form" novalidate');
    expect(html).toContain('id="social-review-note"');
    expect(html).toContain('id="social-review-check"');
  });

  it.each(sections)('%s supports next and previous keyset pages without skipping the first page', () => {
    const first = { ...emptyPage(), next: 'cursor-2' };
    const secondTarget = olderPage(first);
    expect(secondTarget).toEqual({ cursor: 'cursor-2', previous: [null] });
    const second = { ...secondTarget!, next: 'cursor-3' };
    const third = olderPage(second);
    expect(third).toEqual({ cursor: 'cursor-3', previous: [null, 'cursor-2'] });
    expect(newerPage({ ...third!, next: null })).toEqual({ cursor: 'cursor-2', previous: [null] });
    expect(newerPage(second)).toEqual({ cursor: null, previous: [] });
    expect(newerPage(first)).toBeNull();
    expect(olderPage(emptyPage())).toBeNull();
  });

  it('limits editorial actions by state and requires a note and checked confirmation', () => {
    expect(reviewActions('draft')).toEqual(['approve', 'reject']);
    expect(reviewActions('approved')).toEqual(['revoke']);
    expect(reviewActions('rejected')).toEqual([]);
    expect(reviewActions('revoked')).toEqual([]);
    expect(source).toContain("reason.length < 5 || reason.length > 240");
    expect(source).toContain('if (!check.checked)');
    expect(source).toContain("api('/admin/social/review'");
  });

  it('allowlists approved export fields without credentials, wallets or audit notes', () => {
    const item = { id: 'draft-1', eventId: 'event-1', eventType: 'hunt_success', sourceWorldTime: 88,
      body: 'A grounded update', status: 'approved', createdAt: '2026-01-01', reviewedAt: null,
      walletAddress: '0xPRIVATE', adminToken: 'PRIVATE', note: 'PRIVATE' } as Draft;
    const file = exportDocument([item, { ...item, id: 'draft-2', status: 'revoked' }]);
    expect(file).toEqual({ format: 'vana-social-dry-run-v1', published: false,
      items: [{ eventId: 'event-1', eventType: 'hunt_success', sourceWorldTime: 88, body: 'A grounded update' }] });
    expect(JSON.stringify(file)).not.toContain('PRIVATE');
    expect(source).toContain('await freshExportItems()');
    expect(source).toContain("candidate.id === item.id");
    expect(source).toContain('fresh.body !== item.body');
  });

  it('projects only export-retrieval metadata and explains its limited meaning', () => {
    const entry = { id: '42', source_world_time: '86400', source_next_sequence: '7',
      requested_cursor: null, next_cursor: '24', draft_ids: ['draft-1'], item_count: 1,
      first_fetched_at: '2026-09-25T00:00:00Z', last_fetched_at: '2026-09-25T01:00:00Z', fetch_count: '2',
      body: 'PRIVATE BODY', wallet: 'PRIVATE WALLET', token: 'PRIVATE TOKEN', response_fingerprint: 'PRIVATE HASH' } as ExportAuditEntry;
    const facts = exportAuditFacts(entry);
    expect(facts).toEqual({ id: '42', source_world_time: '86400', source_next_sequence: '7',
      requested_cursor: null, next_cursor: '24', draft_ids: ['draft-1'], item_count: 1,
      first_fetched_at: '2026-09-25T00:00:00Z', last_fetched_at: '2026-09-25T01:00:00Z', fetch_count: '2' });
    expect(JSON.stringify(facts)).not.toContain('PRIVATE');
    expect(source).toContain('exportAuditFacts(raw)');
    expect(source).toContain("void load('export-audit')");
    expect(source).toContain("if (!fresh.length) throw new Error('No approved updates remain on this page')");
    expect(html).toContain('Non-empty export page retrievals are server-audited');
    expect(html).toContain('retrieval is not proof of copying, downloading or posting');
    expect(html).not.toContain('Export retrieval and clipboard use are not audit-logged');
  });

  it('refreshes access records after retrieval even when clipboard or download cannot complete', () => {
    const retrieval = source.slice(source.indexOf('async function freshExportItems()'), source.indexOf('async function copyText('));
    const copy = source.slice(source.indexOf('async function copyText('), source.indexOf("$('#social-login').addEventListener"));
    const download = source.slice(source.indexOf("$<HTMLButtonElement>('#social-download').onclick"),
      source.indexOf("$<HTMLButtonElement>('#social-review-cancel').onclick"));
    expect(retrieval).toContain('const requestGeneration = generation');
    expect(retrieval).toContain('const result = await api(`/admin/social/export');
    expect(retrieval).toContain("if (token && requestGeneration === generation) void load('export-audit')");
    expect(copy).toContain("if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')");
    expect(download).toContain("if (!fresh.length) throw new Error('No approved updates remain on this page')");
    expect(copy).not.toContain("load('export-audit')");
    expect(download).not.toContain("load('export-audit')");
    expect((source.match(/void load\('export-audit'\)/g) ?? [])).toHaveLength(1);
  });

  it('keeps social bearer secret in memory and clears private DOM on auth failure', () => {
    expect(source).not.toMatch(/(?:localStorage|sessionStorage|indexedDB|document\.cookie)/);
    expect(source).toContain('const requestToken = token');
    expect(source).toContain('response.status === 401');
    expect(source).toContain("token = ''; generation++;");
    expect(source).toContain('replaceChildren()');
    expect(source).toContain("$('#social-review-copy').textContent = ''");
    expect(source).toContain("$<HTMLInputElement>('#social-token').value = ''");
    expect(source).toContain("addEventListener('pagehide', () => lock())");
    expect(html).toContain('clipboard use and local downloads are not publication');
    expect(html).toContain('X posting is only possible when separately configured');
  });

  it('offers an explicit one-shot X review and uncertain-result reconciliation path', () => {
    expect(html).toContain('id="social-x-dialog"');
    expect(html).toContain('id="social-x-text" readonly');
    expect(html).toContain('id="social-x-check"');
    expect(html).toContain('id="social-x-publish" type="button" disabled');
    expect(html).toContain('id="social-x-post-id"');
    expect(source).toContain("api('/admin/social/x-config')");
    expect(source).toContain("api('/admin/social/x-prepare', { draftId: item.id })");
    expect(source).toContain("api('/admin/social/x-publish', { draftId: target.id })");
    expect(source).toContain("api('/admin/social/x-reconcile', { draftId: target.id, xPostId: id })");
    expect(source).toContain('xAttempted.add(target.id)');
    expect(source).toContain("$('#social-x-state').textContent = 'Outcome not confirmed. Do not resend;");
  });

  it('formats world time defensively', () => {
    expect(worldClock(0)).toBe('Day 1, hour 0');
    expect(worldClock(90_000)).toBe('Day 2, hour 1');
    expect(worldClock(-1)).toBe('Unknown world time');
  });
});
