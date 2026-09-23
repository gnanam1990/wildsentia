import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './testDatabase.js';

describe('testDatabaseUrl', () => {
  // The server tests truncate every table. They once read DATABASE_URL, the same database the
  // live world writes to, so running the suite wiped the forest's history.
  it('is undefined when no test database is configured, so database tests skip', () => {
    expect(testDatabaseUrl({})).toBeUndefined();
  });

  it('ignores DATABASE_URL, which belongs to the live world', () => {
    expect(testDatabaseUrl({ DATABASE_URL: 'postgres://vana:vana@localhost:5433/vana' })).toBeUndefined();
  });

  it('accepts a database whose name ends in _test', () => {
    const url = 'postgres://vana:vana@localhost:5433/vana_test';
    expect(testDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });

  it('refuses to point the destructive tests at any other database', () => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://vana:vana@localhost:5433/vana' }))
      .toThrow(/_test/);
  });
});
