/**
 * The database the server tests may use. These tests truncate every table, so they read
 * TEST_DATABASE_URL, never DATABASE_URL (which is the live world's), and refuse any database
 * whose name does not end in `_test`. Unset, the database tests skip.
 */
export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.TEST_DATABASE_URL;
  if (!url) return undefined;
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL points at "${name}". The server tests truncate every table, so the ` +
      'database name must end in _test.',
    );
  }
  return url;
}
