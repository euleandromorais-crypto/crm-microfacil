import pg from 'pg';
import { config } from '../config.js';

// bigint (int8) -> number; numeric -> number; date permanece string (YYYY-MM-DD)
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool do PostgreSQL', err);
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool) {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Queryable = pool) {
  const res = await db.query<T>(text, params as any[]);
  return (res.rows[0] ?? null) as T | null;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Construtor simples de cláusulas WHERE parametrizadas. */
export class Sql {
  params: unknown[] = [];
  where: string[] = [];
  constructor(initialParams: unknown[] = []) {
    this.params = [...initialParams];
  }
  /** adiciona um parâmetro e devolve o placeholder ($n) */
  p(value: unknown) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  and(clause: string) {
    this.where.push(clause);
    return this;
  }
  whereSql(prefix = 'WHERE') {
    return this.where.length ? `${prefix} ${this.where.join(' AND ')}` : '';
  }
}
