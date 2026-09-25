/** Shared cursor boundary used by the live HUD and on-demand history dialog. */
export const validNextCursor = (v: unknown): v is string | null =>
  v === null || typeof v === 'string' && v.length > 0 && v.length <= 4096;
