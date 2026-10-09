import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, Sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { currentUser, isManager, requireRole } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getSetting, setSetting, SETTINGS_DEFAULTS, SettingsKey } from '../lib/settings.js';
import { optDate, optStr, parse } from '../lib/validate.js';
import { crud } from './crud.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'cor inválida').default('#64748b');

export async function adminRoutes(app: FastifyInstance) {
  // ---------------- Configurações gerais ----------------
  app.get('/api/settings', async (req) => {
    currentUser(req);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(SETTINGS_DEFAULTS) as SettingsKey[]) out[k] = await getSetting(k);
    return out;
  });

  const settingsSchemas: Record<SettingsKey, z.ZodObject<any>> = {
    general: z.object({
      company_name: z.string().max(120),
      sla_first_contact_minutes: z.coerce.number().int().min(1).max(10080),
      stale_lead_days: z.coerce.number().int().min(1).max(365),
      reactivation_days: z.coerce.number().int().min(1).max(3650),
      opportunity_stale_days: z.coerce.number().int().min(1).max(365),
      sellers_see_unassigned: z.boolean(),
      sources: z.array(z.string().trim().min(1).max(80)).max(100),
    }).partial(),
    distribution: z.object({
      mode: z.enum(['manual', 'round_robin', 'least_loaded']),
      auto_create_opportunity: z.boolean(),
      auto_first_contact_task: z.boolean(),
      first_contact_task_minutes: z.coerce.number().int().min(0).max(1440),
    }).partial(),
    whatsapp: z.object({
      auto_create_lead: z.boolean(),
      default_source: z.string().max(80),
      assign_to_lead_owner: z.boolean(),
      distribute_unassigned: z.boolean(),
      reopen_on_inbound: z.boolean(),
    }).partial(),
  };

  app.put('/api/settings/:key', async (req) => {
    const key = (req.params as any).key as SettingsKey;
    if (!(key in settingsSchemas)) throw notFound('Configuração inexistente');
    const actor = key === 'general' ? requireRole(req, 'admin') : requireRole(req, 'admin', 'manager');
    const body = parse(settingsSchemas[key], req.body);
    const value = await setSetting(key, body as any, actor.id);
    await audit({ userId: actor.id, action: `settings.${key}`, entityType: 'settings', changes: body, ip: req.ip });
    return value;
  });

  // ---------------- Etiquetas ----------------
  crud(app, {
    path: '/api/tags', table: 'tags', entity: 'tag', orderBy: 'name', writeRoles: ['admin', 'manager'],
    schema: z.object({ name: z.string().trim().min(1).max(60), color }),
    listSql: `SELECT t.*, (SELECT count(*) FROM lead_tags lt WHERE lt.tag_id=t.id)::int AS leads FROM tags t ORDER BY name`,
  });

  // ---------------- Campos personalizados ----------------
  crud(app, {
    path: '/api/custom-fields', table: 'custom_fields', entity: 'custom_field', orderBy: 'position, id', writeRoles: ['admin'],
    jsonColumns: ['options'],
    schema: z.object({
      key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,40}$/, 'use letras minúsculas, números e _ (ex.: escolaridade)'),
      label: z.string().trim().min(1).max(80),
      type: z.enum(['text', 'textarea', 'number', 'date', 'select', 'boolean']),
      options: z.array(z.string().trim().min(1)).default([]),
      required: z.boolean().default(false),
      position: z.coerce.number().int().default(0),
      active: z.boolean().default(true),
    }),
  });

  // ---------------- Motivos de perda ----------------
  crud(app, {
    path: '/api/lost-reasons', table: 'lost_reasons', entity: 'lost_reason', orderBy: 'position, name', writeRoles: ['admin', 'manager'],
    schema: z.object({ name: z.string().trim().min(1).max(120), active: z.boolean().default(true), position: z.coerce.number().int().default(0) }),
  });

  // ---------------- Respostas rápidas ----------------
  app.get('/api/quick-replies', async (req) => {
    const u = currentUser(req);
    return (await pool.query(`SELECT * FROM quick_replies WHERE owner_id IS NULL OR owner_id=$1 ORDER BY shortcut`, [u.id])).rows;
  });
  const qrSchema = z.object({
    shortcut: z.string().trim().min(1).max(40).regex(/^[\p{L}0-9_-]+$/u, 'atalho deve conter apenas letras, números, _ ou -'),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4096),
    shared: z.boolean().default(false),
  });
  app.post('/api/quick-replies', async (req) => {
    const u = currentUser(req);
    const body = parse(qrSchema, req.body);
    if (body.shared && !isManager(u)) throw forbidden('Somente gestores criam respostas compartilhadas');
    return queryOne(`INSERT INTO quick_replies (shortcut, title, body, owner_id) VALUES ($1,$2,$3,$4) RETURNING *`, [body.shortcut, body.title, body.body, body.shared ? null : u.id]);
  });
  app.patch('/api/quick-replies/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const qr = await queryOne('SELECT * FROM quick_replies WHERE id=$1', [id]);
    if (!qr) throw notFound();
    if (qr.owner_id ? qr.owner_id !== u.id : !isManager(u)) throw forbidden();
    const body = parse(qrSchema.partial(), req.body);
    return queryOne(`UPDATE quick_replies SET shortcut=COALESCE($2,shortcut), title=COALESCE($3,title), body=COALESCE($4,body), updated_at=now() WHERE id=$1 RETURNING *`, [
      id, body.shortcut ?? null, body.title ?? null, body.body ?? null,
    ]);
  });
  app.delete('/api/quick-replies/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const qr = await queryOne('SELECT * FROM quick_replies WHERE id=$1', [id]);
    if (!qr) throw notFound();
    if (qr.owner_id ? qr.owner_id !== u.id : !isManager(u)) throw forbidden();
    await pool.query('DELETE FROM quick_replies WHERE id=$1', [id]);
    return { ok: true };
  });

  // ---------------- Campanhas e investimento ----------------
  crud(app, {
    path: '/api/campaigns', table: 'campaigns', entity: 'campaign', orderBy: 'active DESC, name', writeRoles: ['admin', 'manager'],
    schema: z.object({
      name: z.string().trim().min(1).max(200),
      utm_campaign: optStr(200),
      channel: optStr(60),
      external_id: optStr(100),
      start_date: optDate,
      end_date: optDate,
      active: z.boolean().default(true),
      notes: optStr(2000),
    }),
    listSql: `SELECT c.*, (SELECT count(*) FROM leads l WHERE l.campaign_id=c.id AND l.deleted_at IS NULL)::int AS leads,
                     (SELECT COALESCE(sum(amount),0) FROM campaign_spend s WHERE s.campaign_id=c.id) AS spend
                FROM campaigns c ORDER BY c.active DESC, c.created_at DESC`,
  });

  app.get('/api/campaigns/:id/spend', async (req) => {
    requireRole(req, 'admin', 'manager');
    return (await pool.query('SELECT * FROM campaign_spend WHERE campaign_id=$1 ORDER BY day DESC LIMIT 400', [Number((req.params as any).id)])).rows;
  });
  app.post('/api/campaigns/:id/spend', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const body = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: z.coerce.number().min(0), impressions: z.coerce.number().int().optional(), clicks: z.coerce.number().int().optional() }), req.body);
    const row = await queryOne(
      `INSERT INTO campaign_spend (campaign_id, day, amount, impressions, clicks, source) VALUES ($1,$2,$3,$4,$5,'manual')
       ON CONFLICT (campaign_id, day, source) DO UPDATE SET amount=EXCLUDED.amount, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, updated_at=now() RETURNING *`,
      [id, body.day, body.amount, body.impressions ?? null, body.clicks ?? null],
    );
    await audit({ userId: actor.id, action: 'campaign.spend', entityType: 'campaign', entityId: id, changes: body, ip: req.ip });
    return row;
  });
  app.delete('/api/campaign-spend/:id', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const row = await queryOne(`DELETE FROM campaign_spend WHERE id=$1 AND source='manual' RETURNING *`, [id]);
    if (!row) throw badRequest('Somente lançamentos manuais podem ser excluídos');
    await audit({ userId: actor.id, action: 'campaign.spend_delete', entityType: 'campaign', entityId: row.campaign_id, changes: row, ip: req.ip });
    return { ok: true };
  });

  // ---------------- Auditoria ----------------
  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin');
    const q = req.query as Record<string, string>;
    const sql = new Sql();
    if (q.user_id) sql.and(`a.user_id = ${sql.p(Number(q.user_id))}`);
    if (q.action) sql.and(`a.action ILIKE ${sql.p(`%${q.action}%`)}`);
    if (q.entity_type) sql.and(`a.entity_type = ${sql.p(q.entity_type)}`);
    if (q.entity_id) sql.and(`a.entity_id = ${sql.p(Number(q.entity_id))}`);
    if (q.from) sql.and(`a.created_at >= (${sql.p(q.from)}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
    if (q.to) sql.and(`a.created_at < ((${sql.p(q.to)}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`);
    const page = Math.max(1, Number(q.page ?? 1));
    const size = Math.min(200, Number(q.pageSize ?? 50));
    const rows = (await pool.query(
      `SELECT a.*, u.name AS user_name, count(*) OVER() AS total FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
        ${sql.whereSql()} ORDER BY a.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
      sql.params,
    )).rows;
    return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0, page, pageSize: size };
  });
}
