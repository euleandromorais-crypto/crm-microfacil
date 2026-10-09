import type { FastifyInstance } from 'fastify';
import { pool, queryOne } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { CONDITION_FIELDS, EVENT_TRIGGERS, ruleSchema, runRule, SCHEDULE_TRIGGERS } from '../services/automations.js';

export async function automationRoutes(app: FastifyInstance) {
  app.get('/api/automations/meta', async (req) => {
    requireRole(req, 'admin', 'manager');
    return { eventTriggers: EVENT_TRIGGERS, scheduleTriggers: SCHEDULE_TRIGGERS, conditionFields: CONDITION_FIELDS };
  });

  app.get('/api/automations', async (req) => {
    requireRole(req, 'admin', 'manager');
    return (await pool.query(`SELECT r.*, u.name AS created_by_name FROM automation_rules r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.position, r.id`)).rows;
  });

  app.post('/api/automations', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const body = parse(ruleSchema, req.body);
    const row = await queryOne(
      `INSERT INTO automation_rules (name, description, trigger, trigger_config, conditions, actions, delay_minutes, active, created_by, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT COALESCE(max(position),0)+1 FROM automation_rules)) RETURNING *`,
      [body.name, body.description ?? null, body.trigger, JSON.stringify(body.trigger_config), JSON.stringify(body.conditions), JSON.stringify(body.actions), body.delay_minutes, body.active, actor.id],
    );
    await audit({ userId: actor.id, action: 'automation.create', entityType: 'automation', entityId: row!.id, changes: body, ip: req.ip });
    return row;
  });

  app.put('/api/automations/:id', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const before = await queryOne('SELECT * FROM automation_rules WHERE id=$1', [id]);
    if (!before) throw notFound('Automação não encontrada');
    const body = parse(ruleSchema, req.body);
    const row = await queryOne(
      `UPDATE automation_rules SET name=$2, description=$3, trigger=$4, trigger_config=$5, conditions=$6, actions=$7, delay_minutes=$8, active=$9, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, body.name, body.description ?? null, body.trigger, JSON.stringify(body.trigger_config), JSON.stringify(body.conditions), JSON.stringify(body.actions), body.delay_minutes, body.active],
    );
    await audit({ userId: actor.id, action: 'automation.update', entityType: 'automation', entityId: id, changes: diff(before, row!, ['name', 'trigger', 'trigger_config', 'conditions', 'actions', 'delay_minutes', 'active']), ip: req.ip });
    return row;
  });

  app.post('/api/automations/:id/toggle', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const row = await queryOne('UPDATE automation_rules SET active = NOT active, updated_at=now() WHERE id=$1 RETURNING id, active', [id]);
    if (!row) throw notFound();
    await audit({ userId: actor.id, action: row.active ? 'automation.enable' : 'automation.disable', entityType: 'automation', entityId: id, ip: req.ip });
    return row;
  });

  app.delete('/api/automations/:id', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    await pool.query('DELETE FROM automation_rules WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'automation.delete', entityType: 'automation', entityId: id, ip: req.ip });
    return { ok: true };
  });

  /** Execução manual de teste sobre um lead específico (útil para validar a regra) */
  app.post('/api/automations/:id/test', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const body = req.body as { lead_id?: number; opportunity_id?: number };
    const rule = await queryOne('SELECT * FROM automation_rules WHERE id=$1', [id]);
    if (!rule) throw notFound();
    const status = await runRule(rule, { leadId: body.lead_id ?? null, opportunityId: body.opportunity_id ?? null }, `test:${Date.now()}`);
    await audit({ userId: actor.id, action: 'automation.test', entityType: 'automation', entityId: id, changes: { ...body, status }, ip: req.ip });
    const last = await queryOne('SELECT * FROM automation_runs WHERE rule_id=$1 ORDER BY id DESC LIMIT 1', [id]);
    return { status, run: status === 'skipped' ? null : last };
  });

  app.get('/api/automations/runs', async (req) => {
    requireRole(req, 'admin', 'manager');
    const q = req.query as Record<string, string>;
    return (await pool.query(
      `SELECT r.*, a.name AS rule_name FROM automation_runs r JOIN automation_rules a ON a.id=r.rule_id
        WHERE ($1::bigint IS NULL OR r.rule_id=$1) AND ($2::text IS NULL OR r.status=$2) AND r.status <> 'skipped'
        ORDER BY r.created_at DESC LIMIT $3`,
      [q.rule_id ? Number(q.rule_id) : null, q.status || null, Math.min(500, Number(q.limit ?? 100))],
    )).rows;
  });
}
