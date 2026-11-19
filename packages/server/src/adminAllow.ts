import { BlockList, isIP } from 'node:net';

/**
 * Where the admin routes may be reached from (audit 17 November, hardening): VANA_ADMIN_ALLOW_IPS,
 * a comma-separated list of addresses and CIDR ranges, IPv4 or IPv6. Unset, the admin routes answer
 * from anywhere, guarded by their tokens alone, as before. Set, a request from anywhere else is
 * answered 404, as if the route did not exist, before its token is looked at.
 *
 * The address is the visitor's as the API sees it (VANA_TRUSTED_PROXY_HOPS): behind Caddy and
 * Cloudflare, the address Caddy took from Cloudflare.
 */
export interface AdminAllowList { allows(ip: string): boolean; readonly entries: number }

/** The admin routes: /admin/… (rewards, social) and /congo/admin/… (bounties, Arc bounties). */
export const ADMIN_PATH = /^\/(?:congo\/)?admin(?:\/|$|\?)/;

const plain = (ip: string) => (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

export function adminAllowList(env: NodeJS.ProcessEnv): AdminAllowList | null {
  const raw = env.VANA_ADMIN_ALLOW_IPS?.trim();
  if (!raw) return null;
  const list = new BlockList();
  let entries = 0;
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, bits, extra] = item.split('/');
    const family = isIP(address ?? '');
    if (!family || extra !== undefined) throw new Error(`Invalid VANA_ADMIN_ALLOW_IPS entry: ${item}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(address!, type);
    else {
      const prefix = Number(bits);
      if (!/^\d{1,3}$/.test(bits) || prefix > (family === 4 ? 32 : 128)) throw new Error(`Invalid VANA_ADMIN_ALLOW_IPS entry: ${item}`);
      list.addSubnet(address!, prefix, type);
    }
    entries++;
  }
  if (!entries) throw new Error('VANA_ADMIN_ALLOW_IPS lists no address');
  return {
    entries,
    allows: (ip) => { const a = plain(ip), family = isIP(a); return !!family && list.check(a, family === 4 ? 'ipv4' : 'ipv6'); },
  };
}
