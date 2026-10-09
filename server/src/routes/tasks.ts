import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, Sql, withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertLeadAccess, AuthUser, currentUser, isManager, ownerScope } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { notifyUser } from '../lib/notify.js';
import { publish } from '../lib/realtime.js';
import { optId, optStr, parse } from '../lib/validate.js';
import { completeTask, createTask, TASK_TYPES, taskInputSchema } from '../services/tasks.js';
import { addLeadEvent } from '../services/timeline.js';

async function loadTask(u: AuthUser, id: number) {
  const t = await queryOne('SELECT * FROM tasks WHERE id=$1', [id]);
  if (!t) throw notFound('Atividade não encontrada');
  if (t.assignee_id === u.id || t.created_by === u.id || u.role === 'admin') return t;
  if (u.role === 'manager') {
    if (!u.teamId || !t.assignee_id) return t;
    const a = await queryOne('SELECT team_id FROM users WHERE id=$1', [t.assignee_id]);
    if (a?.team_id === u.teamId) return t;
  }
  throw forbidden('Você não tem acesso a esta atividade');
}

const TASK_SELECT = `
  SELECT t.*, u.name AS assignee_name, cb.name AS created_by_name, l.name AS lead_name, l.phone AS lead_phone, o.title AS opportunity_title,
         (t.status='pending' AND t.due_at < now()) AS overdue
    FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN users cb ON cb.id=t.created_by
    LEFT JOIN leads l ON l.id=t.lead_id
    LEFT JOIN opportunities o ON o.id=t.opportunity_id`;

export async function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (req) => {
    const u = currentUser(req);
    const q = req.query as Record<string, string>;
    const sql = new Sql();
    sql.and(`(${ownerScope(u, sql, 't.assignee_id')} OR t.created_by = ${sql.p(u.id)})`);
    sql.and('(t.lead_id IS NULL OR l.deleted_at IS NULL)');
    if (q.assignee_id) sql.and(`t.assignee_id = ANY(${sql.p(q.assignee_id.split(',').map(Number))}::bigint[])`);
    if (q.status) sql.and(`t.status = ANY(${sql.p(q.status.split(','))}::text[])`);
    if (q.type) sql.and(`t.type = ANY(${sql.p(q.type.split(','))}::text[])`);
    if (q.lead_id) sql.and(`t.lead_id = ${sql.p(Number(q.lead_id))}`);
    if (q.from) sql.and(`t.due_at >= ${sql.p(q.from)}::timestamptz`);
    if (q.to) sql.and(`t.due_at < ${sql.p(q.to)}::timestamptz`);
    if (q.overdue === 'true') sql.and(`t.status='pending' AND t.due_at < now()`);
    if (q.q) sql.and(`(t.title ILIKE ${sql.p(`%${q.q}%`)} OR l.name ILIKE ${sql.p(`%${q.q}%`)})`);
    const limit = Math.min(2000, Number(q.limit ?? 500));
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    return (await pool.query(`${TASK_SELECT} ${sql.whereSql()} ORDER BY t.due_at ${order}, t.id LIMIT ${limit}`, sql.params)).rows;
  });

  /** Resumo para o cabeçalho da agenda e alertas */
  app.get('/api/tasks/summary', async (req) => {
    const u = currentUser(req);
    const q = req.query as Record<string, string>;
    const sql = new Sql();
    sql.and(ownerScope(u, sql, 't.assignee_id'));
    if (q.assignee_id) sql.and(`t.assignee_id = ANY(${sql.p(q.assignee_id.split(',').map(Number))}::bigint[])`);
    return queryOne(
      `SELECT count(*) FILTER (WHERE t.status='pending' AND t.due_at < now())::int AS overdue,
              count(*) FILTER (WHERE t.status='pending' AND (t.due_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today,
              count(*) FILTER (WHERE t.status='pending' AND t.due_at BETWEEN now() AND now() + interval '1 hour')::int AS next_hour,
              count(*) FILTER (WHERE t.status='pending')::int AS pending,
              count(*) FILTER (WHERE t.status='done' AND (t.completed_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS done_today
         FROM tasks t ${sql.whereSql()}`,
      sql.params,
    );
  });

  app.get('/api/tasks/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadTask(u, id);
    return queryOne(`${TASK_SELECT} WHERE t.id=$1`, [id]);
  });

  app.post('/api/tasks', async (req) => {
    const u = currentUser(req);
    const body = parse(taskInputSchema, req.body);
    if (body.lead_id) await assertLeadAccess(u, body.lead_id);
    if (body.assignee_id && body.assignee_id !== u.id && !isManager(u)) throw forbidden('Somente gestores atribuem atividades a outros usuários');
    const t = await withTx((db) => createTask(db, { ...body, source: 'manual' }, u.id));
    return t;
  });

  app.patch('/api/tasks/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const before = await loadTask(u, id);
    const body = parse(
      z.object({
        type: z.enum(TASK_TYPES).optional(),
        title: z.string().trim().min(1).max(300).optional(),
        description: optStr(5000).optional(),
        assignee_id: optId.optional(),
        due_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'data/hora inválida').optional(),
        duration_minutes: z.coerce.number().int().min(0).max(1440).optional(),
        remind_minutes_before: z.coerce.number().int().min(0).optional(),
        lead_id: optId.optional(),
        opportunity_id: optId.optional(),
      }),
      req.body,
    );
    if (body.assignee_id !== undefined && body.assignee_id !== before.assignee_id && !isManager(u) && body.assignee_id !== u.id) {
      throw forbidden('Somente gestores atribuem atividades a outros usuários');
    }
    if (body.lead_id) await assertLeadAccess(u, body.lead_id);
    const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
    const params: unknown[] = [id, ...keys.map((k) => (k === 'due_at' ? new Date((body as any)[k]) : (body as any)[k]))];
    const sets = keys.map((k, i) => `${k}=$${i + 2}`);
    const rescheduled = body.due_at && new Date(body.due_at).getTime() !== new Date(before.due_at).getTime();
    if (rescheduled) sets.push('reminded_at=NULL', 'overdue_notified_at=NULL', 'reschedule_count=reschedule_count+1');
    if (!sets.length) return before;
    const after = await queryOne(`UPDATE tasks SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, params);
    if (rescheduled && before.lead_id) {
      await addLeadEvent(before.lead_id, 'task_rescheduled', { task_id: id, title: after!.title, from: before.due_at, to: after!.due_at }, u.id);
    }
    if (body.assignee_id && body.assignee_id !== before.assignee_id && body.assignee_id !== u.id) {
      await notifyUser({ userId: body.assignee_id, type: 'task.assigned', title: 'Atividade atribuída a você', body: after!.title, link: `/agenda?task=${id}` });
    }
    await publish({ type: 'task.updated', id, users: [after!.assignee_id, before.assignee_id].filter(Boolean), managers: true });
    return after;
  });

  app.post('/api/tasks/:id/complete', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadTask(u, id);
    const body = parse(
      z.object({
        outcome: optStr(2000).optional(),
        /** cria o próximo acompanhamento na mesma ação */
        next: z.object({ title: z.string().trim().min(1).max(300), due_at: z.string(), type: z.enum(TASK_TYPES).default('followup') }).optional().nullable(),
      }),
      req.body ?? {},
    );
    return withTx(async (db) => {
      const done = await completeTask(db, id, u.id, body.outcome ?? null);
      let next = null;
      if (body.next) {
        next = await createTask(db, { ...body.next, lead_id: done.lead_id, opportunity_id: done.opportunity_id, assignee_id: done.assignee_id ?? u.id }, u.id);
      }
      return { task: done, next };
    });
  });

  app.post('/api/tasks/:id/reopen', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadTask(u, id);
    const t = await queryOne(`UPDATE tasks SET status='pending', completed_at=NULL, outcome=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    await publish({ type: 'task.updated', id, users: t!.assignee_id ? [t!.assignee_id] : undefined, managers: true });
    return t;
  });

  app.post('/api/tasks/:id/cancel', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const before = await loadTask(u, id);
    if (before.status !== 'pending') throw badRequest('Somente atividades pendentes podem ser canceladas');
    const t = await queryOne(`UPDATE tasks SET status='canceled', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    if (before.lead_id) await addLeadEvent(before.lead_id, 'task_canceled', { task_id: id, title: before.title }, u.id);
    await publish({ type: 'task.updated', id, users: t!.assignee_id ? [t!.assignee_id] : undefined, managers: true });
    return t;
  });

  app.delete('/api/tasks/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const t = await loadTask(u, id);
    if (!isManager(u) && t.created_by !== u.id) throw forbidden('Somente quem criou a atividade ou gestores podem excluí-la');
    await pool.query('DELETE FROM tasks WHERE id=$1', [id]);
    await audit({ userId: u.id, action: 'task.delete', entityType: 'task', entityId: id, changes: t, ip: req.ip });
    await publish({ type: 'task.updated', id, users: t.assignee_id ? [t.assignee_id] : undefined, managers: true });
    return { ok: true };
  });
}
