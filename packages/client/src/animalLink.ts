/** Animal identities currently issued by the server, bounded before use in a route. */
export const isAnimalLinkId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

export function animalFromHash(hash: string): string | null {
  if (hash.length > 1024) return null;
  const values = new URLSearchParams(hash.replace(/^#/, '')).getAll('animal');
  return values.length === 1 && isAnimalLinkId(values[0]) ? values[0] : null;
}

/**
 * The page fragment naming the followed animal, so the address bar can be copied or reloaded
 * to come back to it. Other fragment values are kept; `null` (or an identity a shared link
 * would refuse) removes the animal.
 */
export function followedHash(hash: string, id: string | null): string {
  const params = new URLSearchParams(hash.length > 1024 ? '' : hash.replace(/^#/, ''));
  params.delete('animal');
  if (id !== null && isAnimalLinkId(id)) params.append('animal', id);
  const text = params.toString();
  return text ? `#${text}` : '';
}

/** Never copy debug parameters, credentials or an unrelated fragment into a public story. */
export function animalLink(currentUrl: string, id: string): string | null {
  if (!isAnimalLinkId(id)) return null;
  try {
    const url = new URL(currentUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = ''; url.hash = new URLSearchParams({ animal: id }).toString();
    return url.href.length <= 400 ? url.href : null;
  } catch { return null; }
}

/** Shared links may point to an archived animal; the passport resolves it after initial load. */
export function initialFollowId(hash: string, previous: string | null, living: ReadonlyMap<string, unknown>): string | null {
  return animalFromHash(hash) ?? (previous !== null && living.has(previous) ? previous : living.keys().next().value ?? null);
}
