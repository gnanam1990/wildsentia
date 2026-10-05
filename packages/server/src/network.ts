import { isIPv6 } from 'node:net';

/**
 * The visitor a per-address limit counts against. An IPv6 host is normally given a whole /64,
 * so counting single addresses would let one machine rotate through 2^64 fresh allowances;
 * IPv4 (including IPv4 written as IPv6) is counted as the address itself.
 */
export function networkKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const bare = ip.split('%')[0]!;
  if (!isIPv6(bare)) return ip;
  const groups = (s: string) => s === '' ? [] : s.split(':').flatMap((g) => g.includes('.') ? ['0', '0'] : [g]);
  const [head = '', tail] = bare.toLowerCase().split('::');
  const before = groups(head), after = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
