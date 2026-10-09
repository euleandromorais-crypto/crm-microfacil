import { parse as parseCsv } from 'csv-parse/sync';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { assertLeadAccess, currentUser, isManager, requireRole } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { formatPhone } from '../lib/phone.js';
import { publish } from '../lib/realtime.js';
import { formatDateTimeBR } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { pickOwner } from '../services/distribution.js';
import {
  assignLead, changeLeadStatus, findDuplicate, insertLead, intakeLead, LEAD_STATUSES, leadInputSchema, mergeLeads,
  normalizeContact, touchLeadInteraction, updateLead,
} from '../services/leads.js';
import { addLeadEvent } from '../services/timeline.js';
import { buildLeadWhere, LEAD_SORTS, LeadFilters } from './leadQuery.js';
import { sendTable } from './export.js';

export const STATUS_LABELS: Record<string, string> = {
  new: 'Novo', attempting: 'Tentando contato', in_progress: 'Em atendimento', qualified: 'Qualificado',
  customer: 'Matriculado', lost: 'Perdido', unqualified: 'Desqualificado',
};

const LIST_SELECT = `
  SELECT l.id, l.name, l.phone, l.email, l.status, l.source, l.owner_id, u.name AS owner_name, l.course_id, c.name AS course_name,
         l.campaign_id, cp.name AS campaign_name, l.utm_source, l.utm_campaign, l.created_at, l.first_contact_at, l.last_interaction_at,
         l.reactivation_flag, l.city, l.state, l.custom,
         ARRAY(SELECT tag_id FROM lead_tags lt WHERE lt.lead_id=l.id) AS tag_ids,
         (SELECT count(*) FROM opportunities o WHERE o.lead_id=l.id AND o.status='open')::int AS open_opportunities,
         (SELECT bool_or(cv.awaiting_reply) FROM conversations cv WHERE cv.lead_id=l.id AND cv.status<>'closed') AS awaiting_reply
    FROM leads l
    LEFT JOIN users u ON u.id=l.owner_id
    LEFT JOIN courses c ON c.id=l.course_id
    LEFT JOIN campaigns cp ON cp.id=l.campaign_id`;

export async function leadRoutes(app: FastifyInstance) {
  app.get('/api/leads', async (req) => {
    const u = currentUser(req);
    const q = req.query as LeadFilters & { page?: string; pageSize?: string; sort?: string; dir?: string };
    const sql = await buildLeadWhere(u, q);
    const page = Math.max(1, Number(q.page ?? 1));
    const size = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));
    const sort = LEAD_SORTS[q.sort ?? 'created_at'] ?? 'l.created_at';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const [rows, total] = await Promise.all([
      pool.query(`${LIST_SELECT} ${sql.whereSql()} ORDER BY ${sort} ${dir} NULLS LAST, l.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, sql.params),
      queryOne(`SELECT count(*)::int AS n FROM leads l ${sql.whereSql()}`, sql.params),
    ]);
    return { rows: rows.rows, total: total!.n, page, pageSize: size };
  });

  app.get('/api/leads/export', async (req, reply) => {
    const u = requireRole(req, 'admin', 'manager');
    const q = req.query as LeadFilters & { format?: string };
    const sql = await buildLeadWhere(u, q);
    const rows = (await pool.query(`${LIST_SELECT} ${sql.whereSql()} ORDER BY l.created_at DESC LIMIT 100000`, sql.params)).rows;
    const fields = (await pool.query('SELECT key, label FROM custom_fields WHERE active ORDER BY position, id')).rows;
    const tags = new Map((await pool.query('SELECT id, name FROM tags')).rows.map((t) => [t.id, t.name]));
    await audit({ userId: u.id, action: 'lead.export', entityType: 'lead', changes: { filters: q, count: rows.length }, ip: req.ip });
    const header = ['ID', 'Nome', 'Telefone', 'E-mail', 'Status', 'Origem', 'Campanha', 'utm_source', 'utm_campaign', 'Curso', 'Responsável', 'Cidade', 'UF', 'Etiquetas', 'Entrada', 'Primeiro contato', 'Última interação', ...fields.map((f) => f.label)];
    const data = rows.map((r) => [
      r.id, r.name, formatPhone(r.phone), r.email ?? '', STATUS_LABELS[r.status] ?? r.status, r.source ?? '', r.campaign_name ?? '', r.utm_source ?? '', r.utm_campaign ?? '',
      r.course_name ?? '', r.owner_name ?? '', r.city ?? '', r.state ?? '', (r.tag_ids ?? []).map((t: number) => tags.get(t)).filter(Boolean).join(', '),
      formatDateTimeBR(r.created_at), formatDateTimeBR(r.first_contact_at), formatDateTimeBR(r.last_interaction_at), ...fields.map((f) => r.custom?.[f.key] ?? ''),
    ]);
    return sendTable(reply, q.format === 'xlsx' ? 'xlsx' : 'csv', 'leads', header, data);
  });

  /** Verificação de duplicidade em tempo real (formulário de cadastro) */
  app.get('/api/leads/check-duplicate', async (req) => {
    currentUser(req);
    const q = req.query as { phone?: string; email?: string; exclude?: string };
    const { phone, email } = normalizeContact({ phone: q.phone, email: q.email }, false);
    const dup = await findDuplicate(pool, { phone, email, excludeId: q.exclude ? Number(q.exclude) : undefined });
    if (!dup) return { duplicate: null };
    const owner = dup.owner_id ? await queryOne('SELECT name FROM users WHERE id=$1', [dup.owner_id]) : null;
    return { duplicate: { id: dup.id, name: dup.name, phone: dup.phone, email: dup.email, owner_name: owner?.name ?? null, status: dup.status } };
  });

  app.get('/api/leads/duplicates', async (req) => {
    requireRole(req, 'admin', 'manager');
    const rows = (await pool.query(
      `WITH base AS (
         SELECT id, name, phone, email, owner_id, status, created_at,
                CASE WHEN phone LIKE '55%' AND length(phone) IN (12,13) THEN substr(phone,3,2) || right(phone,8) ELSE phone END AS phone_key,
                lower(trim(regexp_replace(name, '\\s+', ' ', 'g'))) AS name_key
           FROM leads WHERE deleted_at IS NULL),
       groups AS (
         SELECT 'phone' AS reason, phone_key AS key, array_agg(id ORDER BY created_at) AS ids FROM base WHERE phone_key IS NOT NULL GROUP BY phone_key HAVING count(*) > 1
         UNION ALL
         SELECT 'email', email, array_agg(id ORDER BY created_at) FROM base WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1
         UNION ALL
         SELECT 'name', name_key, array_agg(id ORDER BY created_at) FROM base WHERE length(name_key) >= 8 AND name_key LIKE '% %' GROUP BY name_key HAVING count(*) > 1 AND count(*) <= 5
       )
       SELECT reason, key, ids FROM groups LIMIT 300`,
    )).rows;
    const allIds = [...new Set(rows.flatMap((r) => r.ids))];
    const leads = allIds.length
      ? (await pool.query(`SELECT l.id, l.name, l.phone, l.email, l.status, l.created_at, l.source, u.name AS owner_name,
            (SELECT count(*) FROM opportunities o WHERE o.lead_id=l.id)::int AS opportunities
          FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.id = ANY($1::bigint[])`, [allIds])).rows
      : [];
    const byId = new Map(leads.map((l) => [l.id, l]));
    // remove grupos repetidos (mesmo conjunto de ids por motivos diferentes)
    const seen = new Set<string>();
    return rows
      .filter((g) => {
        const k = [...g.ids].sort().join(',');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((g) => ({ reason: g.reason, key: g.key, leads: g.ids.map((id: number) => byId.get(id)).filter(Boolean) }));
  });

  app.post('/api/leads/merge', async (req) => {
    const u = requireRole(req, 'admin', 'manager');
    const body = parse(z.object({ primary_id: z.number().int(), secondary_ids: z.array(z.number().int()).min(1) }), req.body);
    for (const id of [body.primary_id, ...body.secondary_ids]) await assertLeadAccess(u, id);
    return mergeLeads(body.primary_id, body.secondary_ids, u);
  });

  app.post('/api/leads', async (req) => {
    const u = currentUser(req);
    const body = parse(leadInputSchema.extend({ create_opportunity: z.boolean().default(true), force: z.boolean().default(false) }), req.body);
    // vendedor cria leads para si mesmo
    if (u.role === 'seller') body.owner_id = u.id;
    const lead = await withTx(async (db) => {
      const { phone, email } = normalizeContact(body);
      const dup = await findDuplicate(db, { phone, email });
      if (dup) throw badRequest(`Já existe um lead com este telefone ou e-mail: #${dup.id} — ${dup.name}`, { duplicateId: dup.id });
      const l = await insertLead(db, body, { actor: u, via: 'manual', distribute: !body.owner_id, enforceRequired: true });
      if (body.create_opportunity) {
        const { createOpportunity } = await import('../services/opportunities.js');
        await createOpportunity(db, { lead_id: l.id }, u.id);
      }
      return l;
    });
    await audit({ userId: u.id, action: 'lead.create', entityType: 'lead', entityId: lead.id, ip: req.ip });
    return lead;
  });

  app.get('/api/leads/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const merged = await queryOne('SELECT merged_into_id FROM leads WHERE id=$1 AND merged_into_id IS NOT NULL', [id]);
    if (merged) return { redirect: merged.merged_into_id };
    await assertLeadAccess(u, id);
    const lead = await queryOne(
      `SELECT l.*, u.name AS owner_name, c.name AS course_name, cp.name AS campaign_name, cb.name AS created_by_name,
              ARRAY(SELECT tag_id FROM lead_tags lt WHERE lt.lead_id=l.id) AS tag_ids
         FROM leads l LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN courses c ON c.id=l.course_id
         LEFT JOIN campaigns cp ON cp.id=l.campaign_id LEFT JOIN users cb ON cb.id=l.created_by
        WHERE l.id=$1`,
      [id],
    );
    const [opportunities, tasks, conversations] = await Promise.all([
      pool.query(
        `SELECT o.*, s.name AS stage_name, s.kind AS stage_kind, s.color AS stage_color, p.name AS pipeline_name, c.name AS course_name, u.name AS owner_name, lr.name AS lost_reason
           FROM opportunities o JOIN pipeline_stages s ON s.id=o.stage_id JOIN pipelines p ON p.id=o.pipeline_id
           LEFT JOIN courses c ON c.id=o.course_id LEFT JOIN users u ON u.id=o.owner_id LEFT JOIN lost_reasons lr ON lr.id=o.lost_reason_id
          WHERE o.lead_id=$1 ORDER BY (o.status='open') DESC, o.created_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
          WHERE t.lead_id=$1 ORDER BY (t.status='pending') DESC, CASE WHEN t.status='pending' THEN t.due_at END ASC, t.completed_at DESC NULLS LAST LIMIT 100`,
        [id],
      ),
      pool.query(
        `SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name, c.last_message_at, c.last_message_preview, c.unread_count, c.awaiting_reply, c.last_inbound_at, c.contact_wa_id
           FROM conversations c LEFT JOIN users u ON u.id=c.assignee_id WHERE c.lead_id=$1 ORDER BY c.last_message_at DESC NULLS LAST`,
        [id],
      ),
    ]);
    return { ...lead, opportunities: opportunities.rows, tasks: tasks.rows, conversations: conversations.rows };
  });

  app.patch('/api/leads/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    const body = parse(leadInputSchema.partial(), req.body);
    if (u.role === 'seller' && body.owner_id !== undefined) {
      const cur = await queryOne('SELECT owner_id FROM leads WHERE id=$1', [id]);
      if (body.owner_id !== cur?.owner_id) throw forbidden('Somente gestores podem alterar o responsável. Use a transferência de atendimento.');
    }
    return updateLead(id, body, u);
  });

  app.delete('/api/leads/:id', async (req) => {
    const u = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    await pool.query('UPDATE leads SET deleted_at=now(), updated_at=now() WHERE id=$1', [id]);
    await audit({ userId: u.id, action: 'lead.delete', entityType: 'lead', entityId: id, ip: req.ip });
    await publish({ type: 'lead.updated', leadId: id });
    return { ok: true };
  });

  /** LGPD: anonimiza dados pessoais mantendo apenas dados agregados (atendimento a solicitação do titular) */
  app.post('/api/leads/:id/anonymize', async (req) => {
    const u = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    await withTx(async (db) => {
      await db.query(
        `UPDATE leads SET name='Titular anonimizado', phone=NULL, email=NULL, document=NULL, birth_date=NULL, city=NULL, notes=NULL,
           custom='{}', referrer_url=NULL, external_ref=NULL, deleted_at=COALESCE(deleted_at, now()), updated_at=now() WHERE id=$1`,
        [id],
      );
      await db.query(`UPDATE messages SET body=NULL, raw=NULL, media_path=NULL WHERE conversation_id IN (SELECT id FROM conversations WHERE lead_id=$1)`, [id]);
      await db.query(`UPDATE conversations SET contact_name=NULL, contact_wa_id='anon-' || id, last_message_preview=NULL WHERE lead_id=$1`, [id]);
      await db.query(`UPDATE lead_events SET data='{}' WHERE lead_id=$1 AND type IN ('note','intake_data','updated','whatsapp_in','whatsapp_out','reentry')`, [id]);
    });
    await audit({ userId: u.id, action: 'lead.anonymize', entityType: 'lead', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/leads/:id/timeline', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    const q = req.query as { before?: string; limit?: string; type?: string };
    const limit = Math.min(200, Number(q.limit ?? 50));
    const rows = (await pool.query(
      `SELECT e.*, u.name AS user_name FROM lead_events e LEFT JOIN users u ON u.id=e.user_id
        WHERE e.lead_id=$1 AND ($2::bigint IS NULL OR e.id < $2) AND ($3::text IS NULL OR e.type = ANY(string_to_array($3, ',')))
        ORDER BY e.created_at DESC, e.id DESC LIMIT $4`,
      [id, q.before ? Number(q.before) : null, q.type || null, limit],
    )).rows;
    return { rows, hasMore: rows.length === limit };
  });

  app.get('/api/leads/:id/status-history', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    return (await pool.query(`SELECT h.*, u.name AS user_name FROM lead_status_history h LEFT JOIN users u ON u.id=h.user_id WHERE lead_id=$1 ORDER BY created_at`, [id])).rows;
  });

  app.post('/api/leads/:id/notes', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(10000) }), req.body);
    await addLeadEvent(id, 'note', { text: body.text }, u.id);
    return { ok: true };
  });

  /** Registro manual de contato (ligação, e-mail, presencial) */
  app.post('/api/leads/:id/contact', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await assertLeadAccess(u, id);
    const body = parse(z.object({ channel: z.enum(['call', 'email', 'presencial', 'whatsapp_phone', 'other']), outcome: z.string().trim().max(2000).optional().nullable(), reached: z.boolean().default(true) }), req.body);
    await withTx(async (db) => {
      await addLeadEvent(id, 'contact_logged', body, u.id, db);
      await touchLeadInteraction(db, id, 'out', new Date(), u.id);
      if (body.reached) {
        const l = await queryOne('SELECT status FROM leads WHERE id=$1', [id], db);
        if (l && ['new', 'attempting'].includes(l.status)) await changeLeadStatus(db, id, 'in_progress', u.id, { auto: true });
      }
    });
    return { ok: true };
  });

  // ---------------- Ações em lote ----------------
  app.post('/api/leads/bulk', async (req) => {
    const u = currentUser(req);
    const body = parse(
      z.object({
        ids: z.array(z.number().int()).min(1).max(1000),
        action: z.enum(['assign', 'distribute', 'status', 'add_tag', 'remove_tag', 'delete']),
        owner_id: z.number().int().nullable().optional(),
        status: z.enum(LEAD_STATUSES).optional(),
        tag_id: z.number().int().optional(),
      }),
      req.body,
    );
    if (['assign', 'distribute', 'delete'].includes(body.action) && !isManager(u)) throw forbidden('Ação disponível apenas para gestores');
    // restringe aos leads visíveis ao usuário
    const sql = await buildLeadWhere(u, { ids: body.ids.join(',') });
    const ids = (await pool.query(`SELECT l.id FROM leads l ${sql.whereSql()}`, sql.params)).rows.map((r) => r.id as number);
    let affected = 0;
    await withTx(async (db) => {
      for (const id of ids) {
        switch (body.action) {
          case 'assign':
            if (await assignLead(db, id, body.owner_id ?? null, u.id, 'bulk')) affected++;
            break;
          case 'distribute': {
            const owner = await pickOwner(db);
            if (!owner) throw badRequest('Nenhum vendedor disponível para distribuição (verifique "recebe leads" e o modo de distribuição)');
            if (await assignLead(db, id, owner, u.id, 'distribution')) affected++;
            break;
          }
          case 'status':
            if (!body.status) throw badRequest('Informe o status');
            if (await changeLeadStatus(db, id, body.status, u.id, { bulk: true })) affected++;
            break;
          case 'add_tag':
            affected += (await db.query('INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, body.tag_id])).rowCount ?? 0;
            break;
          case 'remove_tag':
            affected += (await db.query('DELETE FROM lead_tags WHERE lead_id=$1 AND tag_id=$2', [id, body.tag_id])).rowCount ?? 0;
            break;
          case 'delete':
            affected += (await db.query('UPDATE leads SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount ?? 0;
            break;
        }
      }
    });
    await audit({ userId: u.id, action: `lead.bulk_${body.action}`, entityType: 'lead', changes: { ids, owner_id: body.owner_id, status: body.status, tag_id: body.tag_id }, ip: req.ip });
    await publish({ type: 'lead.bulk' });
    return { affected, total: ids.length };
  });

  // ---------------- Importação CSV ----------------
  app.post('/api/leads/import', async (req) => {
    const u = requireRole(req, 'admin', 'manager');
    const file = await req.file();
    if (!file) throw badRequest('Envie um arquivo CSV');
    const buf = await file.toBuffer();
    const fields = file.fields as any;
    const val = (k: string) => fields[k]?.value as string | undefined;
    const mode = val('mode') ?? 'preview';
    let text = buf.toString('utf8');
    if (text.includes('�')) text = buf.toString('latin1'); // planilhas exportadas em ANSI
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] ?? '';
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') ? '\t' : ',';
    let records: string[][];
    try {
      records = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw badRequest(`CSV inválido: ${(err as Error).message}`);
    }
    if (records.length < 2) throw badRequest('O arquivo não possui linhas de dados');
    const headers = records[0];
    const rows = records.slice(1);
    if (rows.length > 20000) throw badRequest('Limite de 20.000 linhas por importação');

    const guess = (h: string) => {
      const k = h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      if (/^(nome|name|nome completo|full_name)$/.test(k)) return 'name';
      if (/(telefone|celular|whats|phone|fone)/.test(k)) return 'phone';
      if (/(e-?mail)/.test(k)) return 'email';
      if (/(curso|course|produto|interesse)/.test(k)) return 'course';
      if (/^(origem|source|fonte)$/.test(k)) return 'source';
      if (/^(cidade|city)$/.test(k)) return 'city';
      if (/^(uf|estado|state)$/.test(k)) return 'state';
      if (/^utm_(source|medium|campaign|term|content)$/.test(k)) return k;
      if (/^(campanha|campaign)$/.test(k)) return 'campaign';
      if (/(observa|notes|nota)/.test(k)) return 'notes';
      if (/^(cpf|documento|document)$/.test(k)) return 'document';
      return '';
    };
    if (mode === 'preview') {
      return { headers, sample: rows.slice(0, 10), total: rows.length, delimiter, suggested: headers.map(guess) };
    }
    const mapping: string[] = JSON.parse(val('mapping') ?? '[]');
    const options = JSON.parse(val('options') ?? '{}') as { distribute?: boolean; create_opportunity?: boolean; source?: string; owner_id?: number; tag_id?: number };
    if (!mapping.includes('name') && !mapping.includes('phone') && !mapping.includes('email')) throw badRequest('Mapeie ao menos nome e telefone ou e-mail');
    const result = { created: 0, updated: 0, errors: [] as { line: number; error: string }[] };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const input: Record<string, any> = { custom: {} };
      mapping.forEach((field, idx) => {
        if (!field || r[idx] === undefined || r[idx] === '') return;
        if (field.startsWith('cf_')) input.custom[field.slice(3)] = r[idx];
        else input[field] = r[idx];
      });
      if (!input.source) input.source = options.source || 'Importação';
      if (options.owner_id) input.owner_id = options.owner_id;
      if (options.tag_id) input.tags = [options.tag_id];
      try {
        if (!input.phone && !input.email) throw new Error('sem telefone ou e-mail válido');
        const res = await intakeLead(input as any, 'import', { createOpportunity: !!options.create_opportunity, actor: u, distribute: !!options.distribute });
        if (res.created) result.created++;
        else result.updated++;
      } catch (err) {
        if (result.errors.length < 500) result.errors.push({ line: i + 2, error: (err as Error).message });
      }
    }
    await audit({ userId: u.id, action: 'lead.import', entityType: 'lead', changes: { file: file.filename, created: result.created, updated: result.updated, errors: result.errors.length }, ip: req.ip });
    return result;
  });
}
