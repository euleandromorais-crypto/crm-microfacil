import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Aplica, em ordem e em transação, as migrations SQL ainda não executadas. */
export async function migrate(log: (msg: string) => void = console.log) {
  const client = await pool.connect();
  try {
    // trava consultiva para impedir migrations concorrentes (ex.: dois processos subindo juntos)
    await client.query('SELECT pg_advisory_lock(8712345)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      log(`Aplicando migration ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
    log(applied ? `${applied} migration(s) aplicada(s).` : 'Banco de dados já está atualizado.');
  } finally {
    await client.query('SELECT pg_advisory_unlock(8712345)').catch(() => {});
    client.release();
  }
}
