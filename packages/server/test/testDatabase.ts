/**
 * The database the server tests may use. These tests truncate every table, so they read
 * TEST_DATABASE_URL, never DATABASE_URL (which is the live world's), and refuse any database
 * whose name does not end in `_test`. Unset, the database tests skip.
 */
export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.TEST_DATABASE_URL;
  if (!url) {
    if (env.VANA_REQUIRE_TEST_DATABASE === '1') throw new Error('TEST_DATABASE_URL is required; database tests must not skip');
    return undefined;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL'); }
  // pg also accepts socket: URLs with a different database in ?db=; suffix checking alone
  // therefore does NOT protect a destructive suite. Accept a deliberately small URL grammar.
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash) {
    throw new Error('TEST_DATABASE_URL must use postgres:// or postgresql:// with a host and no fragment');
  }
  if (!/^\/[a-zA-Z0-9_]+_test$/.test(parsed.pathname)) {
    throw new Error('The destructive test database name must be a plain identifier ending in _test');
  }
  for (const [key, value] of parsed.searchParams) {
    if (key !== 'sslmode' || !['disable', 'verify-full'].includes(value)) {
      throw new Error('TEST_DATABASE_URL permits only sslmode=disable or sslmode=verify-full query options');
    }
  }
  return url;
}
