import { pool, Queryable } from '../db/pool.js';

export async function logIntegration(
  integration: string,
  level: 'info' | 'warn' | 'error',
  action: string,
  message: string,
  data?: unknown,
  db: Queryable = pool,
) {
  await db
    .query('INSERT INTO integration_logs (integration, level, action, message, data) VALUES ($1,$2,$3,$4,$5)', [
      integration,
      level,
      action,
      message.slice(0, 2000),
      data === undefined ? null : JSON.stringify(data),
    ])
    .catch((err) => console.error('falha ao gravar log de integração', err));
}
