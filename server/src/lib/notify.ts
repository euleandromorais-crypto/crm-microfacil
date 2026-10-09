import { pool, Queryable } from '../db/pool.js';
import { publish } from './realtime.js';

export interface NotificationInput {
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/** Cria notificação interna e avisa o usuário em tempo real */
export async function notifyUser(n: NotificationInput, db: Queryable = pool) {
  const r = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [n.userId, n.type, n.title, n.body ?? null, n.link ?? null],
  );
  await publish({ type: 'notification.created', id: r.rows[0].id, users: [n.userId] }, db);
  return r.rows[0].id as number;
}

/** Notifica todos os gestores/administradores ativos (opcionalmente apenas os da equipe) */
export async function notifyManagers(n: Omit<NotificationInput, 'userId'>, teamId?: number | null, db: Queryable = pool) {
  const rows = (
    await db.query(
      `SELECT id FROM users WHERE active AND (role = 'admin' OR (role = 'manager' AND ($1::bigint IS NULL OR team_id IS NULL OR team_id = $1)))`,
      [teamId ?? null],
    )
  ).rows;
  for (const u of rows) await notifyUser({ ...n, userId: u.id }, db);
}
