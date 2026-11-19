import { describe, expect, it } from 'vitest';
import { ADMIN_PATH, adminAllowList } from '../src/adminAllow.js';

// Audit 17 November, hardening: the admin routes can be kept to the operator's addresses.
describe('admin allow list', () => {
  it('is off unless set, and refuses an entry it cannot read', () => {
    expect(adminAllowList({})).toBeNull();
    expect(adminAllowList({ VANA_ADMIN_ALLOW_IPS: ' ' })).toBeNull();
    for (const bad of ['me', '10.0.0.0/33', '10.0.0.1/8/1', '::1/129', 'example.com', ','])
      expect(() => adminAllowList({ VANA_ADMIN_ALLOW_IPS: bad })).toThrow(/VANA_ADMIN_ALLOW_IPS/);
  });

  it('allows the listed addresses and ranges, IPv4 or IPv6, and no other', () => {
    const list = adminAllowList({ VANA_ADMIN_ALLOW_IPS: '203.0.113.7, 198.51.100.0/24,2001:db8::/32' })!;
    expect(list.entries).toBe(3);
    for (const ip of ['203.0.113.7', '198.51.100.250', '::ffff:198.51.100.1', '2001:db8:1::5']) expect(list.allows(ip)).toBe(true);
    for (const ip of ['203.0.113.8', '198.51.101.1', '2001:db9::1', '', 'nonsense']) expect(list.allows(ip)).toBe(false);
  });

  it('covers every admin route and nothing else', () => {
    for (const url of ['/admin/rewards', '/admin/social/drafts?cursor=1', '/congo/admin/arc-bounties', '/congo/admin/bounties/x/cancel', '/admin'])
      expect(ADMIN_PATH.test(url)).toBe(true);
    for (const url of ['/congo/arc-bounties', '/agents/info', '/administration', '/challenges/drafts', '/congo/admins'])
      expect(ADMIN_PATH.test(url)).toBe(false);
  });
});
