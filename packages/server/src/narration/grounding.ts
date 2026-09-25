/** ID/number regexes cannot enforce meaning. Keep facts immutable; allow only neutral framing. */
export const NARRATION_PREFIXES = ['', 'Life record: ', 'Observed: ', 'From the record: '] as const;

export function isGrounded(template: string, rewrite: string): boolean {
  const clean = (text: string): string => text.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '');
  const text = clean(rewrite);
  if (!text || text.length > 220) return false;
  return NARRATION_PREFIXES.some((prefix) => text === clean(prefix + template));
}
