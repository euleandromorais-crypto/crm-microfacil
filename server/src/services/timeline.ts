import { pool, Queryable } from '../db/pool.js';
import { publish } from '../lib/realtime.js';

export async function addLeadEvent(
  leadId: number,
  type: string,
  data: Record<string, unknown> = {},
  userId: number | null = null,
  db: Queryable = pool,
  at?: Date,
) {
  await db.query(`INSERT INTO lead_events (lead_id, type, data, user_id, created_at) VALUES ($1,$2,$3,$4,COALESCE($5, now()))`, [
    leadId,
    type,
    JSON.stringify(data),
    userId,
    at ?? null,
  ]);
  await publish({ type: 'lead.timeline', leadId }, db);
}
