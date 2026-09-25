import { emptyPage, exportAuditFacts, exportDocument, newerPage, olderPage, reviewActions, sections, worldClock,
  type AuditEntry, type Candidate, type Draft, type ExportAuditEntry, type PageState, type ReviewAction, type SocialSection } from './socialAdminModel.js';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const paragraph = (text: string, className = ''): HTMLParagraphElement => {
  const p = document.createElement('p'); p.textContent = text; p.className = className; return p;
};
const actionButton = (label: string, action: (button: HTMLButtonElement) => void): HTMLButtonElement => {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.onclick = () => action(button); return button;
};
const dateLabel = (value: string): string => {
  const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toLocaleString() : 'Unknown date';
};
const sectionState: Record<SocialSection, PageState> = {
  candidates: emptyPage(), drafts: emptyPage(), export: emptyPage(), audit: emptyPage(), 'export-audit': emptyPage(),
};
const requestVersion: Record<SocialSection, number> = { candidates: 0, drafts: 0, export: 0, audit: 0, 'export-audit': 0 };
let token = '';
let generation = 0;
let exportItems: Draft[] = [];
let reviewTarget: { id: string; action: ReviewAction } | null = null;
let reviewTrigger: HTMLElement | null = null;
interface XConfig { enabled: boolean; accountId: string | null }
interface XPlan { draftId: string; request: { body: { text: string } } }
interface XPublication { draftId: string; status: 'unknown' | 'published'; published: boolean; xPostId: string | null }
let xTarget: Draft | null = null;
let xAccountId: string | null = null;
let xTrigger: HTMLElement | null = null;
const xAttempted = new Set<string>();
const status = $<HTMLElement>('#social-status');
const dialog = $<HTMLDialogElement>('#social-review');
const xDialog = $<HTMLDialogElement>('#social-x-dialog');
const note = $<HTMLTextAreaElement>('#social-review-note');
const reviewError = $<HTMLElement>('#social-review-error');

function lock(message = 'Tab locked. Private outbox content cleared.'): void {
  token = ''; generation++; reviewTarget = null; xTarget = null; xAccountId = null; exportItems = [];
  if (dialog.open) dialog.close();
  if (xDialog.open) xDialog.close();
  $<HTMLTextAreaElement>('#social-x-text').value = ''; $('#social-x-account').textContent = '';
  $('#social-x-state').textContent = ''; $('#social-x-error').textContent = '';
  $<HTMLInputElement>('#social-x-post-id').value = '';
  note.value = ''; reviewError.textContent = ''; $('#social-review-copy').textContent = '';
  $<HTMLInputElement>('#social-token').value = '';
  for (const kind of sections) {
    requestVersion[kind]++; sectionState[kind] = emptyPage();
    $(`#social-${kind}-list`).replaceChildren();
    $(`#social-${kind}-status`).textContent = '';
    updatePageControls(kind);
  }
  $<HTMLButtonElement>('#social-download').disabled = true;
  $('#social-work').hidden = true; $('#social-login').hidden = false;
  status.textContent = message;
}

async function api(path: string, body?: object): Promise<unknown> {
  const requestToken = token;
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${requestToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({ error: 'Unexpected server response' })) as { error?: string };
  if (response.status === 401 && token === requestToken)
    lock('Social administrator token rejected. Private data cleared; enter a valid token.');
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), { status: response.status });
  return data;
}

function updatePageControls(kind: SocialSection): void {
  const page = sectionState[kind];
  $<HTMLButtonElement>(`#social-${kind}-older`).hidden = !page.next;
  $<HTMLButtonElement>(`#social-${kind}-newer`).hidden = page.previous.length === 0;
  $(`#social-${kind}-page`).textContent = `Page ${page.previous.length + 1}`;
}

function candidateCard(item: Candidate): HTMLElement {
  const card = document.createElement('article'); card.className = 'social-card';
  const title = document.createElement('h3'); title.textContent = item.type.replaceAll('_', ' ');
  card.append(title,
    paragraph(`${worldClock(item.worldTime)} · patch ${item.patchId} · ${item.outcome}`, 'social-meta'),
    paragraph(`Event ${item.eventId}`, 'social-meta'));
  const actions = document.createElement('div'); actions.className = 'social-card-actions';
  if (item.drafted) actions.append(paragraph('Already drafted', 'social-status-tag'));
  else actions.append(actionButton('Create grounded draft', (button) => { void createDraft(item, button); }));
  card.append(actions); return card;
}

function draftCard(item: Draft): HTMLElement {
  const card = document.createElement('article'); card.className = 'social-card';
  const tag = document.createElement('span'); tag.className = 'social-status-tag'; tag.textContent = item.status;
  const title = document.createElement('h3'); title.textContent = item.eventType.replaceAll('_', ' ');
  card.append(tag, title, paragraph(item.body),
    paragraph(`${worldClock(item.sourceWorldTime)} · event ${item.eventId}`, 'social-meta'),
    paragraph(`Draft ${item.id} · created ${dateLabel(item.createdAt)}`, 'social-meta'));
  const actions = document.createElement('div'); actions.className = 'social-card-actions';
  for (const action of reviewActions(item.status)) actions.append(actionButton(
    action === 'approve' ? 'Approve for export' : action === 'reject' ? 'Reject draft' : 'Revoke approval',
    (button) => openReview(item, action, button)));
  if (actions.childElementCount) card.append(actions);
  return card;
}

function exportCard(item: Draft): HTMLElement {
  const card = document.createElement('article'); card.className = 'social-card';
  const title = document.createElement('h3'); title.textContent = item.eventType.replaceAll('_', ' ');
  const label = document.createElement('label'); label.textContent = `Approved update from ${worldClock(item.sourceWorldTime)}`;
  const text = document.createElement('textarea'); text.readOnly = true; text.value = item.body;
  text.setAttribute('aria-label', `Approved update text for event ${item.eventId}`);
  card.append(title, paragraph(`Event ${item.eventId} · draft ${item.id}`, 'social-meta'), label, text);
  const actions = document.createElement('div'); actions.className = 'social-card-actions';
  actions.append(actionButton('Copy update text', (button) => { void copyText(item, text, button); }));
  actions.append(actionButton('Review X status / publish', (button) => { void openX(item, button); }));
  card.append(actions); return card;
}

function showXState(publication: XPublication): void {
  $<HTMLElement>('#social-x-publish-controls').hidden = true;
  $<HTMLElement>('#social-x-reconcile-controls').hidden = publication.status !== 'unknown';
  $('#social-x-state').textContent = publication.published
    ? `Published as X post ${publication.xPostId}. This draft cannot be sent again.`
    : 'Outcome uncertain. The post may already be public. Do not resend; verify its X post ID below.';
  $<HTMLButtonElement>('#social-x-publish').disabled = true;
}

async function openX(item: Draft, button: HTMLButtonElement): Promise<void> {
  if (!token || button.disabled) return;
  const currentGeneration = generation;
  button.disabled = true; button.textContent = 'Checking X status…';
  try {
    const config = await api('/admin/social/x-config') as XConfig;
    if (!token || generation !== currentGeneration) return;
    if (!config.enabled || !config.accountId || !/^[0-9]{1,30}$/.test(config.accountId)) {
      status.textContent = 'X publishing is disabled on this server. Manual export remains available.'; return;
    }
    let publication: XPublication | null = null;
    try { publication = await api(`/admin/social/x-publications/${item.id}`) as XPublication; }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    let outgoing = `${item.body} [VANA record ${item.id}]`;
    if (!publication && !xAttempted.has(item.id)) {
      const plan = await api('/admin/social/x-prepare', { draftId: item.id }) as XPlan;
      if (plan.draftId !== item.id || typeof plan.request?.body?.text !== 'string')
        throw new Error('X preparation did not match this draft');
      outgoing = plan.request.body.text;
    }
    if (!token || generation !== currentGeneration) return;
    xTarget = item; xAccountId = config.accountId; xTrigger = button;
    $('#social-x-account').textContent = `Configured X account ID: ${config.accountId}`;
    $<HTMLTextAreaElement>('#social-x-text').value = outgoing;
    $('#social-x-error').textContent = '';
    $<HTMLInputElement>('#social-x-post-id').value = '';
    $<HTMLInputElement>('#social-x-check').checked = false;
    $<HTMLButtonElement>('#social-x-publish').disabled = true;
    $<HTMLElement>('#social-x-publish-controls').hidden = false;
    $<HTMLElement>('#social-x-reconcile-controls').hidden = true;
    if (publication) showXState(publication);
    else if (xAttempted.has(item.id)) {
      $<HTMLElement>('#social-x-publish-controls').hidden = true;
      $('#social-x-state').textContent = 'A publish attempt was made in this tab. Outcome could not be read. Do not retry; refresh its status later.';
    } else $('#social-x-state').textContent = 'Not sent. Confirm only if you intend to publish this exact text publicly.';
    xDialog.showModal();
  } catch (error) {
    if (token && generation === currentGeneration)
      status.textContent = `${(error as Error).message}. Nothing was sent by this review action.`;
  } finally { button.disabled = false; button.textContent = 'Review X status / publish'; }
}

function auditCard(item: AuditEntry): HTMLElement {
  const card = document.createElement('article'); card.className = 'social-card';
  const title = document.createElement('h3'); title.textContent = item.action.replaceAll('_', ' ');
  card.append(title, paragraph(item.note || 'No note recorded.'),
    paragraph(`${dateLabel(item.created_at)} · draft ${item.draft_id} · audit ${item.id}`, 'social-meta'));
  return card;
}

function exportAuditCard(raw: ExportAuditEntry): HTMLElement {
  const item = exportAuditFacts(raw);
  const card = document.createElement('article'); card.className = 'social-card';
  const title = document.createElement('h3'); title.textContent = `Approved export page · ${item.item_count} item${item.item_count === 1 ? '' : 's'}`;
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = `Show ${item.draft_ids.length} draft IDs`;
  const ids = document.createElement('ul'); ids.className = 'social-audit-ids';
  for (const id of item.draft_ids) { const line = document.createElement('li'); line.textContent = id; ids.append(line); }
  details.append(summary, ids);
  card.append(title,
    paragraph(`Fetched ${item.fetch_count} time${item.fetch_count === '1' ? '' : 's'} · first ${dateLabel(item.first_fetched_at)} · last ${dateLabel(item.last_fetched_at)}`, 'social-meta'),
    paragraph(`Checkpoint ${worldClock(Number(item.source_world_time))}, sequence ${item.source_next_sequence} · after ${item.requested_cursor ?? 'first page'} · next ${item.next_cursor ?? 'end'}`, 'social-meta'),
    paragraph(`Retrieval audit ${item.id}. This is not proof of a copy, download or published post.`, 'social-meta'), details);
  return card;
}

function render(kind: SocialSection, raw: unknown): string | null {
  const body = raw as { candidates?: Candidate[]; drafts?: Draft[]; items?: Draft[];
    entries?: AuditEntry[] | ExportAuditEntry[]; next?: string | null };
  const items = kind === 'candidates' ? body.candidates : kind === 'drafts' ? body.drafts
    : kind === 'export' ? body.items : body.entries;
  if (!Array.isArray(items) || !(body.next === null || typeof body.next === 'string')) throw new Error('Invalid outbox response');
  const list = $(`#social-${kind}-list`);
  const cards = kind === 'candidates' ? (items as Candidate[]).map(candidateCard)
    : kind === 'drafts' ? (items as Draft[]).map(draftCard)
      : kind === 'export' ? (items as Draft[]).map(exportCard)
        : kind === 'audit' ? (items as AuditEntry[]).map(auditCard)
          : (items as ExportAuditEntry[]).map(exportAuditCard);
  list.replaceChildren(...cards);
  if (kind === 'export') {
    exportItems = items as Draft[];
    $<HTMLButtonElement>('#social-download').disabled = exportItems.length === 0;
  }
  return body.next ?? null;
}

async function load(kind: SocialSection, cursor: string | null = null, previous: Array<string | null> = []): Promise<boolean> {
  if (!token) return false;
  const currentGeneration = generation, version = ++requestVersion[kind];
  const message = $(`#social-${kind}-status`), older = $<HTMLButtonElement>(`#social-${kind}-older`);
  const newer = $<HTMLButtonElement>(`#social-${kind}-newer`);
  message.textContent = 'Loading committed records…'; older.disabled = true; newer.disabled = true;
  try {
    const result = await api(`/admin/social/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!token || currentGeneration !== generation || version !== requestVersion[kind]) return false;
    const next = render(kind, result);
    sectionState[kind] = { cursor, next, previous }; updatePageControls(kind);
    message.textContent = $(`#social-${kind}-list`).childElementCount
      ? `Showing page ${previous.length + 1}. Records may change; refresh before an editorial decision.`
      : 'Nothing here yet. Check another page or return after a committed event.';
    return true;
  } catch (error) {
    if (currentGeneration === generation && version === requestVersion[kind])
      message.textContent = `${(error as Error).message}. Retry with Refresh all; no external action occurred.`;
    return false;
  } finally {
    if (currentGeneration === generation && version === requestVersion[kind]) {
      older.disabled = false; newer.disabled = false;
    }
  }
}

async function refreshAll(): Promise<void> {
  if (!token) return;
  generation++;
  status.textContent = 'Refreshing private outbox…';
  const currentGeneration = generation;
  // The export fetch itself creates an access record; load that audit page afterwards.
  const results = await Promise.all(sections.filter((kind) => kind !== 'export-audit').map((kind) => load(kind)));
  results.push(await load('export-audit'));
  if (token && currentGeneration === generation) status.textContent = results.every(Boolean)
    ? 'Private outbox refreshed. Nothing was posted externally.'
    : 'Some sections could not refresh. Check each section status; nothing was posted externally.';
}

async function createDraft(item: Candidate, button: HTMLButtonElement): Promise<void> {
  if (!token || button.disabled) return;
  button.disabled = true; button.textContent = 'Creating draft…';
  try {
    const draft = await api('/admin/social/drafts', { eventId: item.eventId }) as Draft & { reused: boolean };
    if (!token) return;
    status.textContent = draft.reused ? 'Existing draft reopened; no duplicate created.' : 'Grounded private draft created. Review before export.';
    await Promise.all([load('candidates'), load('drafts'), load('audit')]);
  } catch (error) {
    if (token) status.textContent = `${(error as Error).message}. Retrying this same event ID is idempotent; no post was sent.`;
  } finally { button.disabled = false; button.textContent = 'Create grounded draft'; }
}

function openReview(item: Draft, action: ReviewAction, trigger: HTMLElement): void {
  reviewTarget = { id: item.id, action }; reviewTrigger = trigger;
  const label = action === 'approve' ? 'Approve for dry-run export' : action === 'reject' ? 'Reject this draft' : 'Revoke approval';
  $('#social-review-title').textContent = label;
  $('#social-review-copy').textContent = item.body;
  $<HTMLButtonElement>('#social-review-submit').textContent = label;
  note.value = ''; reviewError.textContent = '';
  $<HTMLInputElement>('#social-review-check').checked = false;
  dialog.showModal(); note.focus();
}

async function freshExportItems(): Promise<Draft[]> {
  const requestGeneration = generation;
  const cursor = sectionState.export.cursor;
  const result = await api(`/admin/social/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`) as { items?: Draft[] };
  // A successful retrieval is audited by the server even if a later copy/download fails.
  // Refresh only the private audit section; never overwrite the action's status/error message.
  if (token && requestGeneration === generation) void load('export-audit');
  if (!Array.isArray(result.items)) throw new Error('Invalid approved export response');
  return result.items.filter((item) => item.status === 'approved');
}

async function copyText(item: Draft, text: HTMLTextAreaElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const currentGeneration = generation;
  try {
    const fresh = (await freshExportItems()).find((candidate) => candidate.id === item.id);
    if (!token || generation !== currentGeneration) return;
    if (!fresh || fresh.body !== item.body) throw new Error('Approval or wording changed');
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(fresh.body);
    if (!token || generation !== currentGeneration) return;
    status.textContent = 'Approved text copied locally. The page retrieval was server-audited; this clipboard action and posting were not.';
  } catch (error) {
    if (!token || generation !== currentGeneration) return;
    if ((error as Error).message === 'Clipboard API unavailable') {
      text.focus(); text.select(); status.textContent = 'Clipboard unavailable. Approved text is selected for manual copy; nothing was posted.';
    } else status.textContent = `${(error as Error).message}. Refresh approvals before copying; nothing was posted.`;
  } finally { button.disabled = false; }
}

$('#social-login').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $<HTMLInputElement>('#social-token').value;
  $<HTMLInputElement>('#social-token').value = '';
  $('#social-login').hidden = true; $('#social-work').hidden = false;
  void refreshAll();
});
$<HTMLButtonElement>('#social-refresh').onclick = () => { void refreshAll(); };
$<HTMLButtonElement>('#social-lock').onclick = () => { lock(); $<HTMLInputElement>('#social-token').focus(); };
addEventListener('pagehide', () => lock());
for (const kind of sections) {
  $<HTMLButtonElement>(`#social-${kind}-older`).onclick = () => {
    const page = olderPage(sectionState[kind]); if (page) void load(kind, page.cursor, page.previous);
  };
  $<HTMLButtonElement>(`#social-${kind}-newer`).onclick = () => {
    const page = newerPage(sectionState[kind]); if (page) void load(kind, page.cursor, page.previous);
  };
  updatePageControls(kind);
}
$<HTMLButtonElement>('#social-download').onclick = async () => {
  if (!token || !exportItems.length) return;
  const button = $<HTMLButtonElement>('#social-download'), currentGeneration = generation;
  button.disabled = true;
  try {
    const fresh = await freshExportItems();
    if (!token || generation !== currentGeneration) return;
    if (!fresh.length) throw new Error('No approved updates remain on this page');
    const file = new Blob([JSON.stringify(exportDocument(fresh), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url; link.download = 'vana-approved-social-dry-run.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    status.textContent = 'Fresh approved JSON downloaded locally. The page retrieval was server-audited; this local download and posting were not.';
  } catch (error) {
    if (token && generation === currentGeneration)
      status.textContent = `${(error as Error).message}. No file was downloaded; refresh approvals and retry.`;
  } finally { if (token && generation === currentGeneration) button.disabled = false; }
};
$<HTMLButtonElement>('#social-review-cancel').onclick = () => dialog.close();
dialog.addEventListener('close', () => { reviewTarget = null; if (reviewTrigger?.isConnected) reviewTrigger.focus(); reviewTrigger = null; });
$<HTMLButtonElement>('#social-x-close').onclick = () => xDialog.close();
xDialog.addEventListener('close', () => {
  xTarget = null; xAccountId = null;
  $<HTMLTextAreaElement>('#social-x-text').value = '';
  $<HTMLInputElement>('#social-x-post-id').value = '';
  $<HTMLInputElement>('#social-x-check').checked = false;
  if (xTrigger?.isConnected) xTrigger.focus();
  xTrigger = null;
});
$<HTMLInputElement>('#social-x-check').onchange = () => {
  $<HTMLButtonElement>('#social-x-publish').disabled = !xTarget || !xAccountId
    || xAttempted.has(xTarget.id) || !$<HTMLInputElement>('#social-x-check').checked;
};
$<HTMLButtonElement>('#social-x-publish').onclick = async () => {
  const target = xTarget, accountId = xAccountId;
  if (!target || !accountId || !$<HTMLInputElement>('#social-x-check').checked || xAttempted.has(target.id)) return;
  const currentGeneration = generation;
  xAttempted.add(target.id);
  const button = $<HTMLButtonElement>('#social-x-publish'); button.disabled = true;
  $('#social-x-state').textContent = 'One publication request in progress. Do not close and retry.';
  try {
    const result = await api('/admin/social/x-publish', { draftId: target.id }) as XPublication;
    if (!token || generation !== currentGeneration || xTarget?.id !== target.id) return;
    if (result.draftId !== target.id || !['published', 'unknown'].includes(result.status))
      throw new Error('Unrecognized publication response');
    showXState(result);
  } catch {
    if (!token || generation !== currentGeneration || xTarget?.id !== target.id) return;
    try {
      const result = await api(`/admin/social/x-publications/${target.id}`) as XPublication;
      if (token && generation === currentGeneration && xTarget?.id === target.id) showXState(result);
    } catch {
      if (token && generation === currentGeneration && xTarget?.id === target.id) {
        $<HTMLElement>('#social-x-publish-controls').hidden = true;
        $<HTMLElement>('#social-x-reconcile-controls').hidden = false;
        $('#social-x-state').textContent = 'Outcome not confirmed. Do not resend; check X and reconcile a matching post ID.';
      }
    }
  }
};
$<HTMLButtonElement>('#social-x-reconcile').onclick = async () => {
  const target = xTarget, id = $<HTMLInputElement>('#social-x-post-id').value.trim();
  if (!target || !/^[0-9]{1,30}$/.test(id)) {
    $('#social-x-error').textContent = 'Enter the numeric X post ID (1–30 digits).'; return;
  }
  const currentGeneration = generation, button = $<HTMLButtonElement>('#social-x-reconcile');
  button.disabled = true; $('#social-x-error').textContent = '';
  $('#social-x-state').textContent = 'Checking the post author and exact text…';
  try {
    const result = await api('/admin/social/x-reconcile', { draftId: target.id, xPostId: id }) as XPublication;
    if (token && generation === currentGeneration && xTarget?.id === target.id) showXState(result);
  } catch (error) {
    if (token && generation === currentGeneration && xTarget?.id === target.id) {
      $('#social-x-error').textContent = `${(error as Error).message}. Verify the exact post ID; never resend the draft.`;
      $('#social-x-state').textContent = 'Outcome still uncertain.';
    }
  } finally { button.disabled = false; }
};
$('#social-review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = reviewTarget, reason = note.value.trim(), check = $<HTMLInputElement>('#social-review-check');
  if (!target) return;
  if (reason.length < 5 || reason.length > 240) {
    reviewError.textContent = 'Enter a specific audit note of 5–240 characters. Do not include secrets.'; note.focus(); return;
  }
  if (!check.checked) { reviewError.textContent = 'Confirm that you reviewed the source wording. No post will be sent.'; check.focus(); return; }
  reviewError.textContent = '';
  const submit = $<HTMLButtonElement>('#social-review-submit'); submit.disabled = true; submit.textContent = 'Saving review…';
  void api('/admin/social/review', { draftId: target.id, action: target.action, note: reason })
    .then(async () => {
      if (!token) return;
      dialog.close(); status.textContent = `Review saved: ${target.action}. This did not publish an update.`;
      await Promise.all([load('drafts'), load('export'), load('audit')]);
    })
    .catch((error: Error) => { if (token) reviewError.textContent = `${error.message}. Refresh the queue before retrying; no post was sent.`; })
    .finally(() => { submit.disabled = false; submit.textContent = 'Confirm decision'; });
});
