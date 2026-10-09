import { pool, Queryable } from '../db/pool.js';

export interface AuditInput {
  userId?: number | null;
  action: string;
  entityType?: string;
  entityId?: number | null;
  changes?: unknown;
  ip?: string | null;
}

export async function audit(input: AuditInput, db: Queryable = pool) {
  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.userId ?? null, input.action, input.entityType ?? null, input.entityId ?? null, input.changes ? JSON.stringify(input.changes) : null, input.ip ?? null],
  );
}

/** Diferença rasa entre dois objetos, restrita às chaves informadas */
export function diff(before: Record<string, any>, after: Record<string, any>, keys?: string[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys ?? Object.keys(after)) {
    if (!(k in after)) continue;
    const a = before[k] instanceof Date ? before[k].toISOString() : before[k];
    const b = after[k] instanceof Date ? after[k].toISOString() : after[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
