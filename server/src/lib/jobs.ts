import { hostname } from 'node:os';
import { pool, Queryable } from '../db/pool.js';

export type JobHandler = (payload: any, job: { id: number; attempts: number }) => Promise<void>;
const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export interface EnqueueOptions {
  runAt?: Date;
  delayMs?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Enfileira um job persistente. Com dedupeKey, ignora se já houver job pendente/rodando com a mesma chave. */
export async function enqueue(type: string, payload: unknown = {}, opts: EnqueueOptions = {}, db: Queryable = pool) {
  const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
  const r = await db.query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running') DO NOTHING
     RETURNING id`,
    [type, JSON.stringify(payload ?? {}), runAt, opts.dedupeKey ?? null, opts.maxAttempts ?? 8],
  );
  if (r.rows[0]) await db.query(`SELECT pg_notify('crm_jobs', '')`);
  return (r.rows[0]?.id as number | undefined) ?? null;
}

/** Atraso exponencial: 30s, 1m, 2m, 4m ... até 1h */
export const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);

const workerId = `${hostname()}:${process.pid}`;

/** Executa até `limit` jobs prontos. Retorna quantos foram processados. */
export async function runDueJobs(limit = 10, log?: { error: (...a: any[]) => void }) {
  // recupera jobs presos (processo morreu durante a execução)
  await pool.query(
    `UPDATE jobs SET status='pending', locked_at=NULL, locked_by=NULL
     WHERE status='running' AND locked_at < now() - interval '10 minutes'`,
  );
  const claimed = (
    await pool.query(
      `UPDATE jobs SET status='running', locked_at=now(), locked_by=$2, attempts=attempts+1
       WHERE id IN (
         SELECT id FROM jobs WHERE status='pending' AND run_at <= now()
         ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, type, payload, attempts, max_attempts`,
      [limit, workerId],
    )
  ).rows;

  for (const job of claimed) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Nenhum handler registrado para o job ${job.type}`);
      await handler(job.payload, { id: job.id, attempts: job.attempts });
      await pool.query(`UPDATE jobs SET status='done', finished_at=now(), locked_at=NULL, last_error=NULL WHERE id=$1`, [job.id]);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const final = job.attempts >= job.max_attempts || (err as any)?.permanent;
      log?.error({ err, jobId: job.id, type: job.type }, 'job falhou');
      await pool.query(
        `UPDATE jobs SET status=$2, run_at=$3, locked_at=NULL, last_error=$4, finished_at=CASE WHEN $2='failed' THEN now() END WHERE id=$1`,
        [job.id, final ? 'failed' : 'pending', new Date(Date.now() + backoffMs(job.attempts)), message.slice(0, 2000)],
      );
    }
  }
  return claimed.length;
}

/** Erro que não deve ser re-tentado */
export class PermanentError extends Error {
  permanent = true;
}

/** Limpeza periódica de jobs antigos concluídos */
export async function pruneJobs() {
  await pool.query(`DELETE FROM jobs WHERE status='done' AND finished_at < now() - interval '7 days'`);
  await pool.query(`DELETE FROM jobs WHERE status='failed' AND finished_at < now() - interval '60 days'`);
}
