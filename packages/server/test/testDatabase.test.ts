import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './testDatabase.js';

describe('testDatabaseUrl', () => {
  it('fails closed in required-database mode rather than silently skipping', () => {
    expect(() => testDatabaseUrl({ VANA_REQUIRE_TEST_DATABASE: '1' })).toThrow('required');
  });
  it.each([
    'socket:/vana_test?db=vana',
    'postgres://localhost/vana_test?host=another-host',
    'postgres://localhost/vana_test?database=vana',
    'postgres://localhost/vana_test?options=-csearch_path=other',
    'postgres://localhost/vana_test?sslmode=no-verify',
    'postgres://localhost/vana%5Ftest',
    'https://localhost/vana_test',
    'postgres://localhost/vana_test#fragment',
  ])('rejects ambiguous/overriding connection syntax: %s', (url) => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: url })).toThrow();
  });
  it('does not leak malformed connection credentials in validation errors', () => {
    try { testDatabaseUrl({ TEST_DATABASE_URL: 'not-a-url-secret-password' }); }
    catch (error) { expect(String(error)).not.toContain('secret-password'); return; }
    throw new Error('expected malformed URL rejection');
  });
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
