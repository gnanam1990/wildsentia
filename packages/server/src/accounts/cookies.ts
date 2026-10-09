import type { FastifyReply, FastifyRequest } from 'fastify';

/** Cookies by hand: the server has no cookie plugin, and needs only a few. */
export function cookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}

export function cookieHeader(name: string, value: string, o: { maxAgeSeconds: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}; HttpOnly; SameSite=Lax${o.secure ? '; Secure' : ''}`;
}

/**
 * A change made with a cookie must come from our own pages: never a cross-site request, the
 * Origin (when sent) must be ours, and the body must be JSON, which a plain form cannot send.
 * Returns false after replying when it does not.
 */
export function sameOriginJson(req: FastifyRequest, reply: FastifyReply, origin: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') { void reply.code(403).send({ error: 'same_origin_required' }); return false; }
  if (req.headers.origin && req.headers.origin !== origin) { void reply.code(403).send({ error: 'origin_mismatch' }); return false; }
  if (!req.headers['content-type']?.startsWith('application/json')) { void reply.code(415).send({ error: 'json_required' }); return false; }
  return true;
}
