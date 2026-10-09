import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, Sql, withTx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { assertLeadAccess, AuthUser, currentUser, ownerScope } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { publish } from '../lib/realtime.js';
import { optDate, optId, optNum, optStr, parse } from '../lib/validate.js';
import { createOpportunity, loseOpportunity, moveOpportunity, opportunityInputSchema, winOpportunity } from '../services/opportunities.js';
import { addLeadEvent } from '../services/timeline.js';

async function loadOpp(u: AuthUser, id: number) {
  const opp = await queryOne('SELECT * FROM opportunities WHERE id=$1', [id]);
  if (!opp) throw notFound('Oportunidade não encontrada');
  // vendedor atua nas oportunidades sob sua responsabilidade ou de leads que ele atende
  if (u.role === 'seller' && opp.owner_id === u.id) return opp;
  await assertLeadAccess(u, opp.lead_id);
  return opp;
}

function oppFilters(u: AuthUser, q: Record<string, string>, sql: Sql) {
  sql.and(`(${ownerScope(u, sql, 'o.owner_id')} OR EXISTS (SELECT 1 FROM leads lx WHERE lx.id=o.lead_id AND lx.owner_id=${sql.p(u.id)}))`);
  sql.and('l.deleted_at IS NULL');
  if (q.pipeline_id) sql.and(`o.pipeline_id = ${sql.p(Number(q.pipeline_id))}`);
  if (q.owner_id) {
    const ids = q.owner_id.split(',');
    const nums = ids.filter((x) => x !== 'none').map(Number);
    const parts = [] as string[];
    if (nums.length) parts.push(`o.owner_id = ANY(${sql.p(nums)}::bigint[])`);
    if (ids.includes('none')) parts.push('o.owner_id IS NULL');
    sql.and(`(${parts.join(' OR ')})`);
  }
  if (q.course_id) sql.and(`o.course_id = ANY(${sql.p(q.course_id.split(',').map(Number))}::bigint[])`);
  if (q.campaign_id) sql.and(`o.campaign_id = ANY(${sql.p(q.campaign_id.split(',').map(Number))}::bigint[])`);
  if (q.status) sql.and(`o.status = ANY(${sql.p(q.status.split(','))}::text[])`);
  if (q.from) sql.and(`o.created_at >= (${sql.p(q.from)}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  if (q.to) sql.and(`o.created_at < ((${sql.p(q.to)}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`);
  if (q.close_from) sql.and(`o.expected_close_date >= ${sql.p(q.close_from)}::date`);
  if (q.close_to) sql.and(`o.expected_close_date <= ${sql.p(q.close_to)}::date`);
  if (q.q) sql.and(`(o.title ILIKE ${sql.p(`%${q.q}%`)} OR l.name ILIKE ${sql.p(`%${q.q}%`)} OR l.phone LIKE ${sql.p(`%${q.q.replace(/\D/g, '') || q.q}%`)})`);
  if (q.stale === 'true') sql.and(`o.status='open' AND o.stage_entered_at < now() - make_interval(days => COALESCE(s.stale_after_days, (SELECT COALESCE((value->>'opportunity_stale_days')::int, 7) FROM settings WHERE key='general'), 7))`);
  return sql;
}

const OPP_SELECT = `
  SELECT o.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email, s.name AS stage_name, s.kind AS stage_kind,
         u.name AS owner_name, c.name AS course_name, cp.name AS campaign_name,
         extract(epoch from (now() - o.stage_entered_at))::bigint AS seconds_in_stage,
         (o.status='open' AND o.stage_entered_at < now() - make_interval(days => COALESCE(s.stale_after_days, (SELECT COALESCE((value->>'opportunity_stale_days')::int, 7) FROM settings WHERE key='general'), 7))) AS is_stale,
         (SELECT min(t.due_at) FROM tasks t WHERE t.opportunity_id=o.id AND t.status='pending') AS next_task_at,
         (SELECT bool_or(cv.awaiting_reply) FROM conversations cv WHERE cv.lead_id=o.lead_id AND cv.status<>'closed') AS awaiting_reply
    FROM opportunities o
    JOIN leads l ON l.id=o.lead_id
    JOIN pipeline_stages s ON s.id=o.stage_id
    LEFT JOIN users u ON u.id=o.owner_id
    LEFT JOIN courses c ON c.id=o.course_id
    LEFT JOIN campaigns cp ON cp.id=o.campaign_id`;

export async function opportunityRoutes(app: FastifyInstance) {
  /** Quadro Kanban: oportunidades por etapa + totais */
  app.get('/api/board', async (req) => {
    const u = currentUser(req);
    const q = req.query as Record<string, string>;
    if (!q.pipeline_id) throw badRequest('Informe o funil');
    const pipeline = await queryOne('SELECT * FROM pipelines WHERE id=$1', [Number(q.pipeline_id)]);
    if (!pipeline) throw notFound('Funil não encontrado');
    const stages = (await pool.query('SELECT * FROM pipeline_stages WHERE pipeline_id=$1 AND NOT archived ORDER BY position, id', [pipeline.id])).rows;
    const sql = oppFilters(u, q, new Sql());
    // etapas finais mostram apenas os últimos 30 dias por padrão (mantém o quadro leve)
    const closedDays = Number(q.closed_days ?? 30);
    sql.and(`(o.status='open' OR COALESCE(o.won_at, o.lost_at) > now() - make_interval(days => ${sql.p(closedDays)}::int))`);
    const perStage = Math.min(500, Number(q.limit ?? 200));
    const rows = (await pool.query(
      `SELECT * FROM (
         SELECT x.*, row_number() OVER (PARTITION BY x.stage_id ORDER BY x.position DESC, x.id DESC) AS rn FROM (${OPP_SELECT} ${sql.whereSql()}) x
       ) y WHERE rn <= ${perStage}`,
      sql.params,
    )).rows;
    const totals = (await pool.query(
      `SELECT o.stage_id, count(*)::int AS count, COALESCE(sum(COALESCE(o.sale_value, o.value)),0) AS total
         FROM opportunities o JOIN leads l ON l.id=o.lead_id JOIN pipeline_stages s ON s.id=o.stage_id ${sql.whereSql()} GROUP BY o.stage_id`,
      sql.params,
    )).rows;
    return {
      pipeline,
      stages: stages.map((s) => {
        const t = totals.find((x) => x.stage_id === s.id);
        return { ...s, count: t?.count ?? 0, total: Number(t?.total ?? 0), opportunities: rows.filter((r) => r.stage_id === s.id) };
      }),
    };
  });

  app.get('/api/opportunities', async (req) => {
    const u = currentUser(req);
    const q = req.query as Record<string, string>;
    const sql = oppFilters(u, q, new Sql());
    const page = Math.max(1, Number(q.page ?? 1));
    const size = Math.min(200, Number(q.pageSize ?? 50));
    const rows = (await pool.query(`${OPP_SELECT} ${sql.whereSql()} ORDER BY o.updated_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, sql.params)).rows;
    const total = await queryOne(`SELECT count(*)::int AS n FROM opportunities o JOIN leads l ON l.id=o.lead_id JOIN pipeline_stages s ON s.id=o.stage_id ${sql.whereSql()}`, sql.params);
    return { rows, total: total!.n, page, pageSize: size };
  });

  app.get('/api/opportunities/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadOpp(u, id);
    const opp = await queryOne(`${OPP_SELECT} WHERE o.id=$1`, [id]);
    const history = (await pool.query(
      `SELECT h.*, fs.name AS from_stage, ts.name AS to_stage, u.name AS user_name FROM opportunity_stage_history h
         LEFT JOIN pipeline_stages fs ON fs.id=h.from_stage_id JOIN pipeline_stages ts ON ts.id=h.to_stage_id LEFT JOIN users u ON u.id=h.user_id
        WHERE h.opportunity_id=$1 ORDER BY h.created_at`,
      [id],
    )).rows;
    const tasks = (await pool.query(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.opportunity_id=$1 ORDER BY t.due_at DESC`, [id])).rows;
    const lostReason = opp.lost_reason_id ? await queryOne('SELECT name FROM lost_reasons WHERE id=$1', [opp.lost_reason_id]) : null;
    return { ...opp, lost_reason: lostReason?.name ?? null, history, tasks };
  });

  app.post('/api/opportunities', async (req) => {
    const u = currentUser(req);
    const body = parse(opportunityInputSchema, req.body);
    await assertLeadAccess(u, body.lead_id);
    if (u.role === 'seller') body.owner_id = u.id;
    const opp = await withTx((db) => createOpportunity(db, body, u.id));
    await audit({ userId: u.id, action: 'opportunity.create', entityType: 'opportunity', entityId: opp.id, ip: req.ip });
    return opp;
  });

  app.patch('/api/opportunities/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const before = await loadOpp(u, id);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        value: optNum.optional(),
        sale_value: optNum.optional(),
        expected_close_date: optDate.optional(),
        course_id: optId.optional(),
        campaign_id: optId.optional(),
        owner_id: optId.optional(),
        source: optStr(80).optional(),
        lost_reason_id: optId.optional(),
        lost_note: optStr(2000).optional(),
      }),
      req.body,
    );
    if (u.role === 'seller' && body.owner_id !== undefined && body.owner_id !== before.owner_id) throw forbidden('Somente gestores podem trocar o responsável');
    if (body.sale_value !== undefined && before.status !== 'won') delete body.sale_value;
    const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await queryOne(`UPDATE opportunities SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => (body as any)[k])]);
    const changes = diff(before, after!, keys);
    if (Object.keys(changes).length) {
      await addLeadEvent(before.lead_id, 'opportunity_updated', { opportunity_id: id, title: after!.title, changes }, u.id);
      await audit({ userId: u.id, action: 'opportunity.update', entityType: 'opportunity', entityId: id, changes, ip: req.ip });
    }
    await publish({ type: 'opportunity.updated', id, leadId: before.lead_id });
    return after;
  });

  app.post('/api/opportunities/:id/move', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadOpp(u, id);
    const body = parse(
      z.object({ stage_id: z.number().int(), position: z.number().optional().nullable(), sale_value: optNum.optional(), lost_reason_id: optId.optional(), lost_note: optStr(2000).optional() }),
      req.body,
    );
    const r = await withTx((db) => moveOpportunity(db, id, body.stage_id, u.id, body));
    await audit({ userId: u.id, action: 'opportunity.move', entityType: 'opportunity', entityId: id, changes: { stage_id: body.stage_id, status: r.status }, ip: req.ip });
    return r;
  });

  app.post('/api/opportunities/:id/win', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadOpp(u, id);
    const body = parse(z.object({ sale_value: z.coerce.number().min(0) }), req.body);
    const r = await withTx((db) => winOpportunity(db, id, body.sale_value, u.id));
    await audit({ userId: u.id, action: 'opportunity.won', entityType: 'opportunity', entityId: id, changes: body, ip: req.ip });
    return r;
  });

  app.post('/api/opportunities/:id/lose', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadOpp(u, id);
    const body = parse(z.object({ lost_reason_id: z.number().int(), lost_note: optStr(2000).optional() }), req.body);
    const r = await withTx((db) => loseOpportunity(db, id, body.lost_reason_id, body.lost_note ?? null, u.id));
    await audit({ userId: u.id, action: 'opportunity.lost', entityType: 'opportunity', entityId: id, changes: body, ip: req.ip });
    return r;
  });

  app.delete('/api/opportunities/:id', async (req) => {
    const u = currentUser(req);
    if (u.role === 'seller') throw forbidden('Somente gestores podem excluir oportunidades');
    const id = Number((req.params as any).id);
    const opp = await loadOpp(u, id);
    await pool.query('DELETE FROM opportunities WHERE id=$1', [id]);
    await addLeadEvent(opp.lead_id, 'opportunity_deleted', { opportunity_id: id, title: opp.title }, u.id);
    await audit({ userId: u.id, action: 'opportunity.delete', entityType: 'opportunity', entityId: id, changes: opp, ip: req.ip });
    await publish({ type: 'opportunity.updated', id, leadId: opp.lead_id });
    return { ok: true };
  });
}
