import pg from 'pg';

export type Pool = pg.Pool;
export type Database = Pick<Pool, 'query'>;

export function createPool(url: string): Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
