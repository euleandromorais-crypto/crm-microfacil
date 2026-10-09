import type { FastifyInstance } from 'fastify';
import { pool, queryOne, Sql } from '../db/pool.js';
import { conversationScope, currentUser, isManager, leadScope } from '../lib/auth.js';
import { bus, RealtimeEvent } from '../lib/realtime.js';

export async function eventsRoutes(app: FastifyInstance) {
  /** Server-Sent Events: avisos de atualização em tempo real (sem dados sensíveis) */
  app.get('/api/events', async (req, reply) => {
    const u = currentUser(req);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // desativa buffer do Nginx
    });
    reply.raw.write(`retry: 3000\n\n`);
    const send = (ev: RealtimeEvent) => {
      if (ev.users && ev.users.length && !ev.users.includes(u.id) && !(ev.managers && isManager(u))) return;
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    bus.on('event', send);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', send);
    });
  });

  app.get('/api/notifications', async (req) => {
    const u = currentUser(req);
    const q = req.query as { unread?: string };
    const rows = (await pool.query(
      `SELECT * FROM notifications WHERE user_id=$1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL) ORDER BY created_at DESC LIMIT 50`,
      [u.id, q.unread === 'true'],
    )).rows;
    const unread = await queryOne('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [u.id]);
    return { rows, unread: unread!.n };
  });

  app.post('/api/notifications/read', async (req) => {
    const u = currentUser(req);
    const body = (req.body ?? {}) as { ids?: number[] };
    if (body.ids?.length) await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [u.id, body.ids]);
    else await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [u.id]);
    return { ok: true };
  });

  /** Busca global: leads, conversas e cursos */
  app.get('/api/search', async (req) => {
    const u = currentUser(req);
    const term = String((req.query as any).q ?? '').trim();
    if (term.length < 2) return { leads: [], conversations: [], courses: [] };
    const digits = term.replace(/\D/g, '');
    const lsql = new Sql();
    const scope = await leadScope(u, lsql);
    const like = lsql.p(`%${term}%`);
    const phone = digits.length >= 4 ? lsql.p(`%${digits}%`) : null;
    const leads = (await pool.query(
      `SELECT l.id, l.name, l.phone, l.email, l.status, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
        WHERE l.deleted_at IS NULL AND ${scope} AND (l.name ILIKE ${like} OR l.email ILIKE ${like}${phone ? ` OR l.phone LIKE ${phone}` : ''})
        ORDER BY similarity(l.name, ${lsql.p(term)}) DESC, l.created_at DESC LIMIT 8`,
      lsql.params,
    )).rows;
    const csql = new Sql();
    const cscope = await conversationScope(u, csql);
    const clike = csql.p(`%${term}%`);
    const conversations = (await pool.query(
      `SELECT c.id, COALESCE(l.name, c.contact_name, c.contact_wa_id) AS name, c.contact_wa_id, c.last_message_preview, c.status
         FROM conversations c LEFT JOIN leads l ON l.id=c.lead_id
        WHERE ${cscope} AND (c.contact_name ILIKE ${clike} OR l.name ILIKE ${clike}${digits.length >= 4 ? ` OR c.contact_wa_id LIKE ${csql.p(`%${digits}%`)}` : ''}
              OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.body ILIKE ${clike}))
        ORDER BY c.last_message_at DESC NULLS LAST LIMIT 6`,
      csql.params,
    )).rows;
    const courses = (await pool.query(`SELECT id, name, code, active FROM courses WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY active DESC, name LIMIT 5`, [`%${term}%`])).rows;
    return { leads, conversations, courses };
  });
}
