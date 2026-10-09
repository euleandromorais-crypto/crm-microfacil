import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, queryOne } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { currentUser, requireRole } from '../lib/auth.js';
import { decryptJson, encrypt, encryptJson, mask, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { enqueue } from '../lib/jobs.js';
import { parse } from '../lib/validate.js';
import { logIntegration } from '../services/integrationLog.js';
import { getMetaApp } from '../services/meta/app.js';
import { graph } from '../services/meta/graph.js';
import { backfillForm } from '../services/meta/leadAds.js';
import { syncAdsInsights } from '../services/meta/adsInsights.js';
import { completeEmbeddedSignup, connectAccount, requestCoexistenceSync, resubscribe, syncTemplates, testAccount } from '../services/whatsapp/account.js';

const baseUrl = () => config.APP_URL.replace(/\/$/, '');

const SECRET_FIELDS: Record<string, string[]> = {
  meta_lead_ads: ['page_access_token'],
  meta_ads_insights: ['access_token'],
  inbound_webhook: ['hmac_secret'],
  outbound_webhook: ['secret'],
};

const OUTBOUND_EVENTS = ['lead.created', 'lead.status_changed', 'lead.owner_changed', 'opportunity.created', 'opportunity.stage_changed', 'opportunity.won', 'opportunity.lost', 'conversation.closed', 'task.completed'];

const integrationSchema = z.object({
  type: z.enum(['meta_lead_ads', 'meta_ads_insights', 'inbound_webhook', 'outbound_webhook']),
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  config: z.record(z.string(), z.any()).default({}),
  secrets: z.record(z.string(), z.string()).optional(),
});

function validateConfig(type: string, cfg: any) {
  if (type === 'outbound_webhook') {
    if (!/^https:\/\//.test(cfg.url ?? '') && config.NODE_ENV === 'production') throw badRequest('A URL do webhook de saída deve usar HTTPS');
    if (!cfg.url) throw badRequest('Informe a URL de destino');
    if (!Array.isArray(cfg.events) || !cfg.events.length) throw badRequest('Selecione ao menos um evento');
    if (cfg.events.some((e: string) => !OUTBOUND_EVENTS.includes(e))) throw badRequest('Evento inválido');
  }
  if (type === 'meta_ads_insights' && !cfg.ad_account_id) throw badRequest('Informe o ID da conta de anúncios');
}

function presentIntegration(row: any) {
  const secrets = decryptJson<Record<string, string>>(row.secrets_enc);
  return {
    ...row,
    secrets_enc: undefined,
    secrets: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, mask(v)])),
    webhook_url: row.type === 'inbound_webhook' ? `${baseUrl()}/webhooks/in/${row.token}` : row.type === 'meta_lead_ads' ? `${baseUrl()}/webhooks/meta` : undefined,
  };
}

export async function integrationRoutes(app: FastifyInstance) {
  // ---------------- Visão geral ----------------
  app.get('/api/integrations/overview', async (req) => {
    requireRole(req, 'admin', 'manager');
    const metaApp = await getMetaApp();
    const accounts = (await pool.query('SELECT id, name, display_phone, verified_name, status, coexistence, quality_rating, last_check_at, last_error, phone_number_id, waba_id FROM wa_accounts ORDER BY id')).rows;
    const integrations = (await pool.query(`SELECT * FROM integrations WHERE type <> 'meta_app' ORDER BY type, id`)).rows.map(presentIntegration);
    const errors24h = (await pool.query(`SELECT integration, count(*)::int AS n FROM integration_logs WHERE level='error' AND created_at > now() - interval '24 hours' GROUP BY integration`)).rows;
    const webhookStats = await queryOne(
      `SELECT count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last24h,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              count(*) FILTER (WHERE status IN ('received','processing') AND received_at < now() - interval '5 minutes')::int AS stuck,
              max(received_at) AS last_received_at
         FROM webhook_events`,
    );
    const jobs = await queryOne(`SELECT count(*) FILTER (WHERE status='failed')::int AS failed, count(*) FILTER (WHERE status='pending' AND run_at < now() - interval '5 minutes')::int AS delayed FROM jobs`);
    return {
      meta_app: metaApp
        ? { configured: !!(metaApp.app_id && metaApp.app_secret), app_id: metaApp.app_id ?? null, app_secret: mask(metaApp.app_secret), verify_token: metaApp.verify_token ?? null, embedded_signup_config_id: metaApp.embedded_signup_config_id ?? null }
        : { configured: false },
      meta_webhook_url: `${baseUrl()}/webhooks/meta`,
      public_leads_url: `${baseUrl()}/api/public/leads`,
      accounts,
      integrations,
      errors24h,
      webhookStats,
      jobs,
      smtp: !!(config.SMTP_HOST && config.SMTP_FROM),
    };
  });

  // ---------------- App da Meta ----------------
  app.put('/api/integrations/meta-app', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(
      z.object({
        app_id: z.string().trim().regex(/^\d+$/, 'App ID numérico'),
        app_secret: z.string().trim().min(10).optional(),
        verify_token: z.string().trim().min(10).optional(),
        embedded_signup_config_id: z.string().trim().optional().nullable(),
      }),
      req.body,
    );
    const current = await getMetaApp();
    const secrets = {
      app_secret: body.app_secret ?? current?.app_secret,
      verify_token: body.verify_token ?? current?.verify_token ?? randomToken(24),
    };
    if (!secrets.app_secret) throw badRequest('Informe o App Secret');
    const cfg = { app_id: body.app_id, embedded_signup_config_id: body.embedded_signup_config_id ?? null };
    if (current) {
      await pool.query(`UPDATE integrations SET config=$2, secrets_enc=$3, status='connected', updated_at=now() WHERE id=$1`, [current.integrationId, JSON.stringify(cfg), encryptJson(secrets)]);
    } else {
      await pool.query(`INSERT INTO integrations (type, name, config, secrets_enc, status) VALUES ('meta_app','App da Meta',$1,$2,'connected')`, [JSON.stringify(cfg), encryptJson(secrets)]);
    }
    await audit({ userId: actor.id, action: 'integration.meta_app', entityType: 'integration', changes: { app_id: body.app_id, app_secret_changed: !!body.app_secret }, ip: req.ip });
    return { ok: true, verify_token: secrets.verify_token };
  });

  /** Dados públicos para o cadastro incorporado (Embedded Signup) no navegador */
  app.get('/api/integrations/embedded-signup-config', async (req) => {
    requireRole(req, 'admin');
    const metaApp = await getMetaApp();
    return { app_id: metaApp?.app_id ?? null, config_id: metaApp?.embedded_signup_config_id ?? null, graph_version: config.META_GRAPH_VERSION };
  });

  // ---------------- Contas de WhatsApp ----------------
  app.get('/api/wa/accounts', async (req) => {
    currentUser(req);
    return (await pool.query('SELECT id, name, display_phone, verified_name, status, coexistence FROM wa_accounts ORDER BY id')).rows;
  });

  app.post('/api/wa/accounts', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        phone_number_id: z.string().trim().regex(/^\d+$/, 'Phone number ID numérico'),
        waba_id: z.string().trim().regex(/^\d+$/, 'WABA ID numérico'),
        access_token: z.string().trim().min(20, 'Token inválido'),
        coexistence: z.boolean().default(false),
      }),
      req.body,
    );
    const id = await connectAccount(body);
    await audit({ userId: actor.id, action: 'whatsapp.connect', entityType: 'wa_account', entityId: id, changes: { ...body, access_token: undefined }, ip: req.ip });
    return queryOne('SELECT id, name, display_phone, status, last_error FROM wa_accounts WHERE id=$1', [id]);
  });

  app.post('/api/wa/embedded-signup', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(
      z.object({ code: z.string().min(5), waba_id: z.string().regex(/^\d+$/), phone_number_id: z.string().regex(/^\d+$/), coexistence: z.boolean().default(true), pin: z.string().optional().nullable(), name: z.string().optional().nullable() }),
      req.body,
    );
    const id = await completeEmbeddedSignup(body);
    await audit({ userId: actor.id, action: 'whatsapp.embedded_signup', entityType: 'wa_account', entityId: id, changes: { waba_id: body.waba_id, phone_number_id: body.phone_number_id, coexistence: body.coexistence }, ip: req.ip });
    return { id };
  });

  app.patch('/api/wa/accounts/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), coexistence: z.boolean().optional(), access_token: z.string().trim().min(20).optional(), disabled: z.boolean().optional() }), req.body);
    const acc = await queryOne('SELECT * FROM wa_accounts WHERE id=$1', [id]);
    if (!acc) throw notFound();
    await pool.query(
      `UPDATE wa_accounts SET name=COALESCE($2,name), coexistence=COALESCE($3,coexistence), access_token_enc=COALESCE($4,access_token_enc),
         status=CASE WHEN $5::boolean IS TRUE THEN 'disabled' WHEN $5::boolean IS FALSE AND status='disabled' THEN 'pending' ELSE status END, updated_at=now() WHERE id=$1`,
      [id, body.name ?? null, body.coexistence ?? null, body.access_token ? encrypt(body.access_token) : null, body.disabled ?? null],
    );
    await audit({ userId: actor.id, action: 'whatsapp.update', entityType: 'wa_account', entityId: id, changes: { ...body, access_token: body.access_token ? 'alterado' : undefined }, ip: req.ip });
    if (body.access_token || body.disabled === false) return testAccount(id);
    return { ok: true };
  });

  app.post('/api/wa/accounts/:id/test', async (req) => {
    requireRole(req, 'admin', 'manager');
    return testAccount(Number((req.params as any).id));
  });
  app.post('/api/wa/accounts/:id/subscribe', async (req) => {
    requireRole(req, 'admin');
    await resubscribe(Number((req.params as any).id));
    return { ok: true };
  });
  app.post('/api/wa/accounts/:id/templates/sync', async (req) => {
    requireRole(req, 'admin', 'manager');
    try {
      return { count: await syncTemplates(Number((req.params as any).id)) };
    } catch (err) {
      throw badRequest(`Falha ao sincronizar modelos: ${(err as Error).message}`);
    }
  });
  app.post('/api/wa/accounts/:id/coexistence-sync', async (req) => {
    requireRole(req, 'admin');
    const body = parse(z.object({ type: z.enum(['smb_app_state_sync', 'history']) }), req.body);
    return requestCoexistenceSync(Number((req.params as any).id), body.type);
  });
  app.delete('/api/wa/accounts/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const n = await queryOne('SELECT count(*)::int AS n FROM conversations WHERE wa_account_id=$1', [id]);
    if (n!.n > 0) {
      await pool.query(`UPDATE wa_accounts SET status='disabled', updated_at=now() WHERE id=$1`, [id]);
      await audit({ userId: actor.id, action: 'whatsapp.disable', entityType: 'wa_account', entityId: id, ip: req.ip });
      return { ok: true, disabled: true, message: 'A conta possui conversas e foi desativada (o histórico foi preservado).' };
    }
    await pool.query('DELETE FROM wa_accounts WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'whatsapp.delete', entityType: 'wa_account', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---------------- Integrações genéricas ----------------
  app.post('/api/integrations', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(integrationSchema, req.body);
    validateConfig(body.type, body.config);
    const secrets = { ...(body.secrets ?? {}) };
    if (body.type === 'outbound_webhook' && !secrets.secret) secrets.secret = randomToken(24);
    const token = body.type === 'inbound_webhook' ? randomToken(24) : null;
    const row = await queryOne(
      `INSERT INTO integrations (type, name, config, secrets_enc, token, active, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [body.type, body.name, JSON.stringify(body.config), encryptJson(secrets), token, body.active],
    );
    await audit({ userId: actor.id, action: 'integration.create', entityType: 'integration', entityId: row!.id, changes: { type: body.type, name: body.name, config: body.config }, ip: req.ip });
    return { ...presentIntegration(row), secret_once: body.type === 'outbound_webhook' ? secrets.secret : undefined };
  });

  app.patch('/api/integrations/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const row = await queryOne('SELECT * FROM integrations WHERE id=$1', [id]);
    if (!row || row.type === 'meta_app') throw notFound();
    const body = parse(integrationSchema.omit({ type: true }).partial(), req.body);
    const cfg = body.config ? { ...row.config, ...body.config } : row.config;
    validateConfig(row.type, cfg);
    const secrets = { ...decryptJson<Record<string, string>>(row.secrets_enc) };
    for (const [k, v] of Object.entries(body.secrets ?? {})) if (v && (SECRET_FIELDS[row.type] ?? []).includes(k)) secrets[k] = v;
    const updated = await queryOne(
      `UPDATE integrations SET name=COALESCE($2,name), active=COALESCE($3,active), config=$4, secrets_enc=$5,
         status=CASE WHEN $3::boolean IS FALSE THEN 'disabled' WHEN status='disabled' AND $3::boolean IS TRUE THEN 'pending' ELSE status END, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, body.name ?? null, body.active ?? null, JSON.stringify(cfg), encryptJson(secrets)],
    );
    await audit({ userId: actor.id, action: 'integration.update', entityType: 'integration', entityId: id, changes: { name: body.name, active: body.active, config: body.config, secrets_changed: Object.keys(body.secrets ?? {}) }, ip: req.ip });
    return presentIntegration(updated);
  });

  app.delete('/api/integrations/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    await pool.query(`DELETE FROM integrations WHERE id=$1 AND type <> 'meta_app'`, [id]);
    await audit({ userId: actor.id, action: 'integration.delete', entityType: 'integration', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/integrations/:id/rotate', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const row = await queryOne('SELECT * FROM integrations WHERE id=$1', [id]);
    if (!row) throw notFound();
    if (row.type === 'inbound_webhook') {
      await pool.query('UPDATE integrations SET token=$2, updated_at=now() WHERE id=$1', [id, randomToken(24)]);
    } else if (row.type === 'outbound_webhook') {
      const secrets = { ...decryptJson<Record<string, string>>(row.secrets_enc), secret: randomToken(24) };
      await pool.query('UPDATE integrations SET secrets_enc=$2, updated_at=now() WHERE id=$1', [id, encryptJson(secrets)]);
      await audit({ userId: actor.id, action: 'integration.rotate', entityType: 'integration', entityId: id, ip: req.ip });
      return { secret_once: secrets.secret };
    } else throw badRequest('Esta integração não possui token rotacionável');
    await audit({ userId: actor.id, action: 'integration.rotate', entityType: 'integration', entityId: id, ip: req.ip });
    return presentIntegration(await queryOne('SELECT * FROM integrations WHERE id=$1', [id]));
  });

  /** Teste de conectividade por tipo de integração */
  app.post('/api/integrations/:id/test', async (req) => {
    requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const row = await queryOne('SELECT * FROM integrations WHERE id=$1', [id]);
    if (!row) throw notFound();
    const secrets = decryptJson<Record<string, string>>(row.secrets_enc);
    const tag = `integration:${id}`;
    try {
      let detail: unknown = null;
      if (row.type === 'meta_lead_ads') {
        if (!secrets.page_access_token) throw new Error('Token da página não configurado');
        const pages = (row.config?.page_ids ?? []) as string[];
        if (!pages.length) throw new Error('Informe ao menos um ID de página');
        const out = [];
        for (const p of pages) {
          const info = await graph(p, { token: secrets.page_access_token, query: { fields: 'id,name' } });
          const subs = await graph<{ data: any[] }>(`${p}/subscribed_apps`, { token: secrets.page_access_token });
          const metaApp = await getMetaApp();
          const subscribed = (subs.data ?? []).some((s: any) => !metaApp?.app_id || String(s.id) === String(metaApp.app_id));
          out.push({ page: info.name, id: info.id, subscribed });
        }
        detail = out;
      } else if (row.type === 'meta_ads_insights') {
        const acc = String(row.config.ad_account_id).replace(/^act_/, '');
        detail = await graph(`act_${acc}`, { token: secrets.access_token, query: { fields: 'name,account_status,currency' } });
      } else if (row.type === 'outbound_webhook') {
        const d = await queryOne(`INSERT INTO outbound_deliveries (integration_id, event, payload) VALUES ($1,'test',$2) RETURNING id`, [id, JSON.stringify({ event: 'test', occurred_at: new Date().toISOString() })]);
        const { deliverOutbound } = await import('../services/outboundWebhooks.js');
        await deliverOutbound({ deliveryId: d!.id }, { attempts: 8 });
        detail = { delivery: d!.id };
      } else if (row.type === 'inbound_webhook') {
        detail = { url: `${baseUrl()}/webhooks/in/${row.token}`, last_event: (await queryOne(`SELECT max(received_at) AS at FROM webhook_events WHERE provider=$1`, [`inbound:${id}`]))?.at };
      }
      await pool.query(`UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL WHERE id=$1`, [id]);
      await logIntegration(tag, 'info', 'test', 'Teste de conexão OK', detail);
      return { ok: true, detail };
    } catch (err) {
      const msg = (err as Error).message;
      await pool.query(`UPDATE integrations SET status='error', last_error_at=now(), last_error=$2 WHERE id=$1`, [id, msg]);
      await logIntegration(tag, 'error', 'test', `Teste falhou: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /** Inscreve o app nas páginas para receber leads (campo leadgen) */
  app.post('/api/integrations/:id/subscribe-pages', async (req) => {
    requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const row = await queryOne(`SELECT * FROM integrations WHERE id=$1 AND type='meta_lead_ads'`, [id]);
    if (!row) throw notFound();
    const secrets = decryptJson<Record<string, string>>(row.secrets_enc);
    const results = [];
    for (const p of (row.config?.page_ids ?? []) as string[]) {
      try {
        await graph(`${p}/subscribed_apps`, { method: 'POST', token: secrets.page_access_token, query: { subscribed_fields: 'leadgen' } });
        results.push({ page: p, ok: true });
      } catch (err) {
        results.push({ page: p, ok: false, error: (err as Error).message });
      }
    }
    await logIntegration(`integration:${id}`, results.every((r) => r.ok) ? 'info' : 'error', 'subscribe', 'Inscrição de páginas no webhook leadgen', results);
    return results;
  });

  app.post('/api/integrations/:id/sync', async (req) => {
    requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const body = parse(z.object({ days: z.number().int().min(1).max(365).default(30) }), req.body ?? {});
    try {
      return { rows: await syncAdsInsights(id, body.days) };
    } catch (err) {
      throw badRequest(`Falha na sincronização: ${(err as Error).message}`);
    }
  });

  app.post('/api/integrations/:id/backfill', async (req) => {
    requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const body = parse(z.object({ form_id: z.string().regex(/^\d+$/), days: z.number().int().min(1).max(90).default(7) }), req.body);
    try {
      return { queued: await backfillForm(id, body.form_id, body.days) };
    } catch (err) {
      throw badRequest(`Falha ao buscar leads do formulário: ${(err as Error).message}`);
    }
  });

  // ---------------- Chaves de API (formulários e ferramentas externas) ----------------
  app.get('/api/api-keys', async (req) => {
    requireRole(req, 'admin');
    return (await pool.query(`SELECT k.id, k.name, k.prefix, k.scopes, k.allowed_origins, k.default_source, k.default_course_id, k.active, k.last_used_at, k.created_at, u.name AS created_by_name
      FROM api_keys k LEFT JOIN users u ON u.id=k.created_by ORDER BY k.id`)).rows;
  });
  const keySchema = z.object({
    name: z.string().trim().min(1).max(120),
    allowed_origins: z.array(z.string().trim().regex(/^https?:\/\/[^/]+$/, 'origem no formato https://dominio.com.br')).default([]),
    default_source: z.string().trim().max(80).optional().nullable(),
    default_course_id: z.number().int().optional().nullable(),
    active: z.boolean().default(true),
  });
  app.post('/api/api-keys', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(keySchema, req.body);
    const key = `crm_${randomToken(30)}`;
    const row = await queryOne(
      `INSERT INTO api_keys (name, prefix, key_hash, allowed_origins, default_source, default_course_id, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, prefix`,
      [body.name, key.slice(0, 10), sha256(key), body.allowed_origins, body.default_source ?? null, body.default_course_id ?? null, body.active, actor.id],
    );
    await audit({ userId: actor.id, action: 'api_key.create', entityType: 'api_key', entityId: row!.id, changes: { name: body.name }, ip: req.ip });
    return { ...row, key };
  });
  app.patch('/api/api-keys/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const body = parse(keySchema.partial(), req.body);
    const row = await queryOne(
      `UPDATE api_keys SET name=COALESCE($2,name), allowed_origins=COALESCE($3,allowed_origins), default_source=COALESCE($4,default_source),
         default_course_id=CASE WHEN $7 THEN $5 ELSE default_course_id END, active=COALESCE($6,active) WHERE id=$1 RETURNING id`,
      [id, body.name ?? null, body.allowed_origins ?? null, body.default_source ?? null, body.default_course_id ?? null, body.active ?? null, 'default_course_id' in body],
    );
    if (!row) throw notFound();
    await audit({ userId: actor.id, action: 'api_key.update', entityType: 'api_key', entityId: id, changes: body, ip: req.ip });
    return { ok: true };
  });
  app.delete('/api/api-keys/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    await pool.query('DELETE FROM api_keys WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'api_key.delete', entityType: 'api_key', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // ---------------- Logs, eventos e fila ----------------
  app.get('/api/integration-logs', async (req) => {
    requireRole(req, 'admin', 'manager');
    const q = req.query as Record<string, string>;
    return (await pool.query(
      `SELECT * FROM integration_logs WHERE ($1::text IS NULL OR integration = $1 OR integration LIKE $1 || ':%') AND ($2::text IS NULL OR level=$2)
        ORDER BY created_at DESC LIMIT $3`,
      [q.integration || null, q.level || null, Math.min(500, Number(q.limit ?? 100))],
    )).rows;
  });

  app.get('/api/webhook-events', async (req) => {
    requireRole(req, 'admin');
    const q = req.query as Record<string, string>;
    return (await pool.query(
      `SELECT id, provider, status, attempts, error, signature_valid, received_at, processed_at, left(payload::text, 2000) AS payload_preview
         FROM webhook_events WHERE ($1::text IS NULL OR provider LIKE $1 || '%') AND ($2::text IS NULL OR status=$2) ORDER BY received_at DESC LIMIT $3`,
      [q.provider || null, q.status || null, Math.min(500, Number(q.limit ?? 100))],
    )).rows;
  });

  app.post('/api/webhook-events/:id/reprocess', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const ev = await queryOne('SELECT * FROM webhook_events WHERE id=$1', [id]);
    if (!ev) throw notFound();
    await pool.query(`UPDATE webhook_events SET status='received', error=NULL WHERE id=$1`, [id]);
    if (ev.provider === 'meta') await enqueue('meta.webhook', { eventId: id }, { dedupeKey: `wh-${id}` });
    else if (ev.provider.startsWith('inbound:')) await enqueue('inbound.webhook', { eventId: id, integrationId: Number(ev.provider.split(':')[1]) }, { dedupeKey: `wh-${id}` });
    await audit({ userId: actor.id, action: 'webhook.reprocess', entityType: 'webhook_event', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/jobs', async (req) => {
    requireRole(req, 'admin');
    const q = req.query as Record<string, string>;
    return (await pool.query(
      `SELECT id, type, status, attempts, max_attempts, run_at, last_error, created_at, finished_at, left(payload::text, 500) AS payload
         FROM jobs WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 200`,
      [q.status || null],
    )).rows;
  });

  app.post('/api/jobs/:id/retry', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    await pool.query(`UPDATE jobs SET status='pending', run_at=now(), attempts=0, last_error=NULL WHERE id=$1 AND status='failed'`, [id]);
    await pool.query(`SELECT pg_notify('crm_jobs','')`);
    await audit({ userId: actor.id, action: 'job.retry', entityType: 'job', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
