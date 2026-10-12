import pg from 'pg';

export type Pool = pg.Pool;
export type Database = Pick<Pool, 'query'>;

export function createPool(url: string): Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // A dropped connection (a database restart, a network blip) emits 'error'; without a listener
  // Node throws it and the whole server dies. The failing query still rejects for its caller.
  pool.on('error', (error) => console.error('[db] idle connection error', error.message));
  pool.on('connect', (client) => {
    client.on('error', (error) => console.error('[db] connection error', error.message));
  });
  return pool;
}
