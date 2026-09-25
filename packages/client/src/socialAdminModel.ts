export type SocialSection = 'candidates' | 'drafts' | 'export' | 'audit' | 'export-audit';
export type ReviewAction = 'approve' | 'reject' | 'revoke';
export type DraftStatus = 'draft' | 'approved' | 'rejected' | 'revoked';
export interface Candidate { eventId: string; type: string; worldTime: number; patchId: number; outcome: string; drafted: boolean }
export interface Draft { id: string; eventId: string; eventType: string; sourceWorldTime: number; body: string;
  status: DraftStatus; createdAt: string; reviewedAt: string | null }
export interface AuditEntry { id: string; draft_id: string; action: string; note: string; created_at: string }
export interface ExportAuditEntry { id: string; source_world_time: string; source_next_sequence: string;
  requested_cursor: string | null; next_cursor: string | null; draft_ids: string[]; item_count: number;
  first_fetched_at: string; last_fetched_at: string; fetch_count: string }
export interface PageState { cursor: string | null; next: string | null; previous: Array<string | null> }
export const sections: readonly SocialSection[] = ['candidates', 'drafts', 'export', 'audit', 'export-audit'];
/** Project only private retrieval metadata. The server response is never spread into the DOM. */
export function exportAuditFacts(item: ExportAuditEntry): ExportAuditEntry {
  return { id: item.id, source_world_time: item.source_world_time, source_next_sequence: item.source_next_sequence,
    requested_cursor: item.requested_cursor, next_cursor: item.next_cursor,
    draft_ids: [...item.draft_ids], item_count: item.item_count,
    first_fetched_at: item.first_fetched_at, last_fetched_at: item.last_fetched_at, fetch_count: item.fetch_count };
}
export const emptyPage = (): PageState => ({ cursor: null, next: null, previous: [] });
export function olderPage(page: PageState): Pick<PageState, 'cursor' | 'previous'> | null {
  return page.next ? { cursor: page.next, previous: [...page.previous, page.cursor] } : null;
}
export function newerPage(page: PageState): Pick<PageState, 'cursor' | 'previous'> | null {
  return page.previous.length ? { cursor: page.previous.at(-1) ?? null, previous: page.previous.slice(0, -1) } : null;
}
export function reviewActions(status: DraftStatus): readonly ReviewAction[] {
  return status === 'draft' ? ['approve', 'reject'] : status === 'approved' ? ['revoke'] : [];
}
export function worldClock(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return 'Unknown world time';
  return `Day ${Math.floor(seconds / 86_400) + 1}, hour ${Math.floor(seconds % 86_400 / 3_600)}`;
}
/** An explicit, allowlisted dry-run file. Never serialize credentials, audit notes or wallet data. */
export function exportDocument(items: readonly Draft[]): { format: 'vana-social-dry-run-v1'; published: false;
  items: Array<{ eventId: string; eventType: string; sourceWorldTime: number; body: string }> } {
  return { format: 'vana-social-dry-run-v1', published: false,
    items: items.filter((draft) => draft.status === 'approved').map(({ eventId, eventType, sourceWorldTime, body }) =>
      ({ eventId, eventType, sourceWorldTime, body })) };
}
