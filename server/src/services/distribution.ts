import { pool, Queryable } from '../db/pool.js';
import { getSetting, setSetting } from '../lib/settings.js';

/**
 * Escolhe o próximo vendedor para receber um lead.
 * Considera apenas usuários ativos marcados para receber leads, respeitando o limite de leads abertos.
 * Usa trava consultiva na transação para evitar duas atribuições simultâneas ao mesmo "turno" do rodízio.
 */
export async function pickOwner(db: Queryable = pool, opts: { teamId?: number | null } = {}): Promise<number | null> {
  const cfg = await getSetting('distribution', db);
  if (cfg.mode === 'manual') return null;
  await db.query('SELECT pg_advisory_xact_lock(4451001)');

  const candidates = (
    await db.query(
      `SELECT u.id, u.max_open_leads,
              (SELECT count(*) FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL
                 AND l.status IN ('new','attempting','in_progress','qualified')) AS open_leads,
              (SELECT max(l.assigned_at) FROM leads l WHERE l.owner_id = u.id) AS last_assigned
         FROM users u
        WHERE u.active AND u.receives_leads AND ($1::bigint IS NULL OR u.team_id = $1)
        ORDER BY u.id`,
      [opts.teamId ?? null],
    )
  ).rows.filter((u) => u.max_open_leads === null || Number(u.open_leads) < u.max_open_leads);

  if (!candidates.length) return null;

  let chosen: number;
  if (cfg.mode === 'least_loaded') {
    candidates.sort((a, b) => Number(a.open_leads) - Number(b.open_leads) || cmpDate(a.last_assigned, b.last_assigned) || a.id - b.id);
    chosen = candidates[0].id;
  } else {
    // rodízio: próximo id depois do último atribuído
    const last = cfg.last_user_id ?? 0;
    const next = candidates.find((c) => c.id > last) ?? candidates[0];
    chosen = next.id;
  }
  await setSetting('distribution', { last_user_id: chosen }, null, db);
  return chosen;
}

function cmpDate(a: Date | null, b: Date | null) {
  return (a ? new Date(a).getTime() : 0) - (b ? new Date(b).getTime() : 0);
}
