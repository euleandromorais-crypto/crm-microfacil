import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, Queryable, queryOne, withTx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import type { AuthUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notifyManagers, notifyUser } from '../lib/notify.js';
import { normalizeEmail, normalizePhone, phoneVariants } from '../lib/phone.js';
import { publish } from '../lib/realtime.js';
import { getSetting } from '../lib/settings.js';
import { optDate, optId, optStr } from '../lib/validate.js';
import { pickOwner } from './distribution.js';
import { emitDomainEvent } from './domainEvents.js';
import { createOpportunity } from './opportunities.js';
import { createTask } from './tasks.js';
import { addLeadEvent } from './timeline.js';

export const LEAD_STATUSES = ['new', 'attempting', 'in_progress', 'qualified', 'customer', 'lost', 'unqualified'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const OPEN_LEAD_STATUSES: LeadStatus[] = ['new', 'attempting', 'in_progress', 'qualified'];

export const leadInputSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(200),
  phone: optStr(40),
  email: optStr(200),
  document: optStr(40),
  birth_date: optDate,
  city: optStr(120),
  state: optStr(60),
  course_id: optId,
  source: optStr(80),
  campaign_id: optId,
  utm_source: optStr(200),
  utm_medium: optStr(200),
  utm_campaign: optStr(200),
  utm_term: optStr(200),
  utm_content: optStr(200),
  referrer_url: optStr(1000),
  external_ref: optStr(200),
  owner_id: optId,
  status: z.enum(LEAD_STATUSES).optional(),
  custom: z.record(z.string(), z.any()).optional(),
  notes: optStr(10000),
  consent_whatsapp: z.boolean().optional(),
  tags: z.array(z.coerce.number().int().positive()).optional(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

const LEAD_COLUMNS = [
  'name', 'phone', 'email', 'document', 'birth_date', 'city', 'state', 'course_id', 'source', 'campaign_id',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer_url', 'external_ref', 'notes',
] as const;

/** Normaliza e valida contato; lança erro se telefone/e-mail forem informados em formato inválido. */
export function normalizeContact(input: { phone?: string | null; email?: string | null }, strict = true) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const email = input.email ? normalizeEmail(input.email) : null;
  if (strict && input.phone && !phone) throw badRequest('Telefone inválido. Use DDD + número (ex.: 11 99999-8888).', { fields: { phone: 'inválido' } });
  if (strict && input.email && !email) throw badRequest('E-mail inválido.', { fields: { email: 'inválido' } });
  return { phone, email };
}

/** Procura lead existente (não excluído/mesclado) com o mesmo telefone ou e-mail. */
export async function findDuplicate(
  db: Queryable,
  { phone, email, excludeId }: { phone?: string | null; email?: string | null; excludeId?: number },
) {
  const variants = phoneVariants(phone ?? null);
  if (!variants.length && !email) return null;
  return queryOne(
    `SELECT * FROM leads
      WHERE deleted_at IS NULL AND merged_into_id IS NULL AND ($3::bigint IS NULL OR id <> $3)
        AND ((cardinality($1::text[]) > 0 AND phone = ANY($1::text[])) OR ($2::text IS NOT NULL AND email = $2))
      ORDER BY (phone = ANY($1::text[])) DESC, created_at ASC
      LIMIT 1`,
    [variants, email ?? null, excludeId ?? null],
    db,
  );
}

/** Valida campos personalizados contra as definições ativas */
export async function validateCustomFields(custom: Record<string, any> | undefined, db: Queryable, enforceRequired: boolean) {
  if (!custom && !enforceRequired) return undefined;
  const defs = (await db.query('SELECT key, label, type, options, required FROM custom_fields WHERE active')).rows;
  const out: Record<string, any> = {};
  const src = custom ?? {};
  for (const d of defs) {
    let v = src[d.key];
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      switch (d.type) {
        case 'number':
          v = Number(v);
          if (Number.isNaN(v)) throw badRequest(`Campo "${d.label}" deve ser numérico`);
          break;
        case 'boolean':
          v = v === true || v === 'true' || v === '1' || v === 1 || v === 'sim';
          break;
        case 'date':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest(`Campo "${d.label}" deve ser uma data (AAAA-MM-DD)`);
          break;
        case 'select':
          if (Array.isArray(d.options) && d.options.length && !d.options.includes(String(v)))
            throw badRequest(`Valor inválido para "${d.label}"`);
          v = String(v);
          break;
        default:
          v = String(v).slice(0, 5000);
      }
    }
    if (enforceRequired && d.required && (v === null || v === '')) throw badRequest(`Campo "${d.label}" é obrigatório`);
    if (d.key in src) out[d.key] = v;
  }
  return out;
}

async function resolveCampaign(db: Queryable, input: { campaign_id?: number | null; utm_campaign?: string | null; utm_source?: string | null }) {
  if (input.campaign_id) return input.campaign_id;
  if (!input.utm_campaign) return null;
  const existing = await queryOne(`SELECT id FROM campaigns WHERE lower(utm_campaign) = lower($1)`, [input.utm_campaign], db);
  if (existing) return existing.id as number;
  // campanha criada automaticamente a partir do parâmetro UTM, para consolidar relatórios
  const created = await queryOne(
    `INSERT INTO campaigns (name, utm_campaign, channel) VALUES ($1,$1,$2)
     ON CONFLICT ((lower(utm_campaign))) WHERE utm_campaign IS NOT NULL DO UPDATE SET updated_at = now()
     RETURNING id`,
    [input.utm_campaign, input.utm_source ?? null],
    db,
  );
  return created!.id as number;
}

export interface CreateLeadOptions {
  actor?: AuthUser | null;
  /** origem técnica da criação: manual, import, api, meta_lead_ads, whatsapp, webhook */
  via: string;
  /** aplicar distribuição automática quando não houver responsável */
  distribute?: boolean;
  enforceRequired?: boolean;
  createdAt?: Date;
}

export async function insertLead(db: PoolClient, input: LeadInput, opts: CreateLeadOptions) {
  const { phone, email } = normalizeContact(input, opts.via === 'manual');
  if (!phone && !email && opts.via === 'manual') {
    throw badRequest('Informe ao menos telefone ou e-mail do lead.');
  }
  const custom = (await validateCustomFields(input.custom, db, !!opts.enforceRequired)) ?? {};
  const campaignId = await resolveCampaign(db, input);
  let ownerId = input.owner_id ?? null;
  if (ownerId) {
    const ok = await queryOne('SELECT id FROM users WHERE id=$1 AND active', [ownerId], db);
    if (!ok) throw badRequest('Responsável inválido ou inativo');
  } else if (opts.distribute) {
    ownerId = await pickOwner(db);
  }
  const status = input.status ?? 'new';
  const row = await queryOne(
    `INSERT INTO leads (name, phone, email, document, birth_date, city, state, course_id, source, campaign_id,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer_url, external_ref, notes,
        owner_id, assigned_at, status, custom, consent_whatsapp, consent_at, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        CASE WHEN $19::bigint IS NULL THEN NULL ELSE now() END,$20,$21,$22,CASE WHEN $22 THEN now() END,$23,COALESCE($24, now()))
     RETURNING *`,
    [
      input.name.trim(), phone, email, input.document ?? null, input.birth_date ?? null, input.city ?? null, input.state ?? null,
      input.course_id ?? null, input.source ?? null, campaignId, input.utm_source ?? null, input.utm_medium ?? null,
      input.utm_campaign ?? null, input.utm_term ?? null, input.utm_content ?? null, input.referrer_url ?? null,
      input.external_ref ?? null, input.notes ?? null, ownerId, status, JSON.stringify(custom), !!input.consent_whatsapp,
      opts.actor?.id ?? null, opts.createdAt ?? null,
    ],
    db,
  );
  const lead = row!;
  if (input.tags?.length) {
    await db.query(`INSERT INTO lead_tags (lead_id, tag_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [lead.id, input.tags]);
  }
  await db.query(`INSERT INTO lead_status_history (lead_id, from_status, to_status, user_id) VALUES ($1,NULL,$2,$3)`, [
    lead.id,
    status,
    opts.actor?.id ?? null,
  ]);
  await addLeadEvent(lead.id, 'created', { via: opts.via, source: lead.source, campaign_id: campaignId, owner_id: ownerId }, opts.actor?.id ?? null, db);
  if (ownerId) {
    await addLeadEvent(lead.id, 'owner_changed', { from: null, to: ownerId, reason: input.owner_id ? 'manual' : 'distribution' }, opts.actor?.id ?? null, db);
  }
  await emitDomainEvent({ type: 'lead.created', leadId: lead.id, userId: opts.actor?.id ?? null, data: { via: opts.via } }, db);
  await publish({ type: 'lead.created', leadId: lead.id }, db);
  return lead;
}

export async function updateLead(id: number, patch: Partial<LeadInput>, actor: AuthUser) {
  return withTx(async (db) => {
    const before = await queryOne('SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id], db);
    if (!before) throw notFound('Lead não encontrado');
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const contact = normalizeContact({ phone: patch.phone, email: patch.email });
    for (const col of LEAD_COLUMNS) {
      if (!(col in patch)) continue;
      let v = (patch as any)[col];
      if (col === 'phone') v = contact.phone;
      if (col === 'email') v = contact.email;
      if (col === 'name' && !v) throw badRequest('Informe o nome');
      set(col, v ?? null);
    }
    if ('utm_campaign' in patch && !('campaign_id' in patch) && patch.utm_campaign) {
      set('campaign_id', await resolveCampaign(db, { utm_campaign: patch.utm_campaign, utm_source: patch.utm_source ?? before.utm_source }));
    }
    if (patch.custom !== undefined) {
      const custom = await validateCustomFields({ ...before.custom, ...patch.custom }, db, true);
      set('custom', JSON.stringify({ ...before.custom, ...custom }));
    }
    if (patch.consent_whatsapp !== undefined && patch.consent_whatsapp !== before.consent_whatsapp) {
      set('consent_whatsapp', patch.consent_whatsapp);
      set('consent_at', patch.consent_whatsapp ? new Date() : null);
    }
    if (('phone' in patch || 'email' in patch) && (contact.phone || contact.email)) {
      const dup = await findDuplicate(db, { phone: 'phone' in patch ? contact.phone : null, email: 'email' in patch ? contact.email : null, excludeId: id });
      if (dup) throw badRequest(`Já existe outro lead com este telefone ou e-mail (#${dup.id} — ${dup.name}). Use a mesclagem de duplicados.`, { duplicateId: dup.id });
    }
    let after = before;
    if (sets.length) {
      params.push(id);
      after = (await queryOne(`UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params, db))!;
      const changes = diff(before, after, [...LEAD_COLUMNS, 'custom', 'consent_whatsapp']);
      if (Object.keys(changes).length) {
        await addLeadEvent(id, 'updated', { changes }, actor.id, db);
        await audit({ userId: actor.id, action: 'lead.update', entityType: 'lead', entityId: id, changes }, db);
        await emitDomainEvent({ type: 'lead.updated', leadId: id, userId: actor.id, data: { fields: Object.keys(changes) } }, db);
      }
    }
    if (patch.tags) await setLeadTags(db, id, patch.tags);
    if (patch.status && patch.status !== before.status) await changeLeadStatus(db, id, patch.status, actor.id);
    if (patch.owner_id !== undefined && patch.owner_id !== before.owner_id) await assignLead(db, id, patch.owner_id ?? null, actor.id, 'manual');
    await publish({ type: 'lead.updated', leadId: id }, db);
    return (await queryOne('SELECT * FROM leads WHERE id=$1', [id], db))!;
  });
}

export async function setLeadTags(db: Queryable, leadId: number, tagIds: number[]) {
  await db.query('DELETE FROM lead_tags WHERE lead_id=$1 AND NOT (tag_id = ANY($2::bigint[]))', [leadId, tagIds]);
  if (tagIds.length) await db.query('INSERT INTO lead_tags (lead_id, tag_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [leadId, tagIds]);
}

export async function changeLeadStatus(db: Queryable, leadId: number, status: LeadStatus, userId: number | null, extra: Record<string, unknown> = {}) {
  const cur = await queryOne('SELECT status FROM leads WHERE id=$1', [leadId], db);
  if (!cur || cur.status === status) return false;
  await db.query('UPDATE leads SET status=$2, updated_at=now() WHERE id=$1', [leadId, status]);
  await db.query('INSERT INTO lead_status_history (lead_id, from_status, to_status, user_id) VALUES ($1,$2,$3,$4)', [leadId, cur.status, status, userId]);
  await addLeadEvent(leadId, 'status_changed', { from: cur.status, to: status, ...extra }, userId, db);
  await emitDomainEvent({ type: 'lead.status_changed', leadId, userId, data: { from: cur.status, to: status } }, db);
  return true;
}

/** Atribui (ou remove) responsável. Atualiza conversas abertas e notifica o novo responsável. */
export async function assignLead(db: Queryable, leadId: number, ownerId: number | null, actorId: number | null, reason = 'manual') {
  const cur = await queryOne('SELECT id, name, owner_id FROM leads WHERE id=$1', [leadId], db);
  if (!cur) throw notFound('Lead não encontrado');
  if (cur.owner_id === ownerId) return false;
  if (ownerId) {
    const ok = await queryOne('SELECT id FROM users WHERE id=$1 AND active', [ownerId], db);
    if (!ok) throw badRequest('Responsável inválido ou inativo');
  }
  await db.query('UPDATE leads SET owner_id=$2, assigned_at=CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END, updated_at=now() WHERE id=$1', [leadId, ownerId]);
  // conversas que estavam com o responsável anterior (ou sem responsável) acompanham o lead
  await db.query(
    `UPDATE conversations SET assignee_id=$2, updated_at=now()
      WHERE lead_id=$1 AND status <> 'closed' AND (assignee_id IS NULL OR assignee_id IS NOT DISTINCT FROM $3)`,
    [leadId, ownerId, cur.owner_id],
  );
  // oportunidades abertas sem responsável ou com o anterior acompanham
  await db.query(
    `UPDATE opportunities SET owner_id=$2, updated_at=now()
      WHERE lead_id=$1 AND status='open' AND (owner_id IS NULL OR owner_id IS NOT DISTINCT FROM $3)`,
    [leadId, ownerId, cur.owner_id],
  );
  await db.query(
    `UPDATE tasks SET assignee_id=$2, updated_at=now()
      WHERE lead_id=$1 AND status='pending' AND (assignee_id IS NULL OR assignee_id IS NOT DISTINCT FROM $3)`,
    [leadId, ownerId, cur.owner_id],
  );
  await addLeadEvent(leadId, 'owner_changed', { from: cur.owner_id, to: ownerId, reason }, actorId, db);
  if (ownerId && ownerId !== actorId) {
    await notifyUser({ userId: ownerId, type: 'lead.assigned', title: 'Novo lead atribuído a você', body: cur.name, link: `/leads/${leadId}` }, db);
  }
  await emitDomainEvent({ type: 'lead.owner_changed', leadId, userId: actorId, data: { from: cur.owner_id, to: ownerId } }, db);
  await publish({ type: 'lead.updated', leadId }, db);
  return true;
}

/** Registra interação para indicadores (primeiro contato, última interação, status automático) */
export async function touchLeadInteraction(db: Queryable, leadId: number, direction: 'in' | 'out', at: Date = new Date(), userId: number | null = null) {
  if (direction === 'out') {
    await db.query(
      `UPDATE leads SET last_outbound_at = GREATEST(COALESCE(last_outbound_at, $2), $2),
                        last_interaction_at = GREATEST(COALESCE(last_interaction_at, $2), $2),
                        first_contact_at = COALESCE(first_contact_at, $2),
                        reactivation_flag = false, updated_at = now()
        WHERE id = $1`,
      [leadId, at],
    );
    const l = await queryOne('SELECT status FROM leads WHERE id=$1', [leadId], db);
    if (l?.status === 'new') await changeLeadStatus(db, leadId, 'attempting', userId, { auto: true });
  } else {
    await db.query(
      `UPDATE leads SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
                        last_interaction_at = GREATEST(COALESCE(last_interaction_at, $2), $2),
                        reactivation_flag = false, updated_at = now()
        WHERE id = $1`,
      [leadId, at],
    );
    const l = await queryOne('SELECT status, first_contact_at FROM leads WHERE id=$1', [leadId], db);
    if (l?.status === 'attempting') await changeLeadStatus(db, leadId, 'in_progress', null, { auto: true });
  }
}

/**
 * Mescla leads duplicados no lead principal.
 * Move conversas, oportunidades, tarefas, eventos e etiquetas; completa campos vazios; marca os secundários como mesclados.
 */
export async function mergeLeads(primaryId: number, secondaryIds: number[], actor: AuthUser) {
  const ids = secondaryIds.filter((x) => x !== primaryId);
  if (!ids.length) throw badRequest('Selecione ao menos um lead para mesclar');
  return withTx(async (db) => {
    const primary = await queryOne('SELECT * FROM leads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [primaryId], db);
    if (!primary) throw notFound('Lead principal não encontrado');
    const others = (await db.query('SELECT * FROM leads WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL FOR UPDATE', [ids])).rows;
    if (others.length !== ids.length) throw badRequest('Um ou mais leads selecionados não existem mais');

    const fill: Record<string, unknown> = {};
    const fillable = ['phone', 'email', 'document', 'birth_date', 'city', 'state', 'course_id', 'source', 'campaign_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer_url', 'owner_id', 'first_contact_at'];
    for (const col of fillable) {
      if (primary[col] !== null && primary[col] !== undefined) continue;
      const donor = others.find((o) => o[col] !== null && o[col] !== undefined);
      if (donor) fill[col] = donor[col];
    }
    const custom = { ...Object.assign({}, ...others.map((o) => o.custom ?? {})), ...(primary.custom ?? {}) };
    const notes = [primary.notes, ...others.map((o) => o.notes)].filter(Boolean).join('\n\n---\n\n') || null;
    const earliest = [primary, ...others].reduce((a, b) => (new Date(a.created_at) < new Date(b.created_at) ? a : b));

    // telefone/e-mail dos secundários são liberados antes de copiar para o principal
    await db.query('UPDATE leads SET merged_into_id=$1, deleted_at=now(), updated_at=now() WHERE id = ANY($2::bigint[])', [primaryId, ids]);

    const sets = Object.keys(fill).map((k, i) => `${k} = $${i + 2}`);
    await db.query(
      `UPDATE leads SET ${[...sets, `custom = $${sets.length + 2}`, `notes = $${sets.length + 3}`, `created_at = $${sets.length + 4}`,
        `last_interaction_at = (SELECT max(x) FROM unnest(ARRAY[last_interaction_at, $${sets.length + 5}::timestamptz]) x)`, 'updated_at = now()'].join(', ')}
        WHERE id = $1`,
      [primaryId, ...Object.values(fill), JSON.stringify(custom), notes, earliest.created_at,
        others.map((o) => o.last_interaction_at).filter(Boolean).sort().pop() ?? null],
    );
    for (const t of ['opportunities', 'tasks', 'lead_events', 'lead_status_history']) {
      await db.query(`UPDATE ${t} SET lead_id=$1 WHERE lead_id = ANY($2::bigint[])`, [primaryId, ids]);
    }
    await db.query('UPDATE conversations SET lead_id=$1 WHERE lead_id = ANY($2::bigint[])', [primaryId, ids]);
    await db.query(
      `INSERT INTO lead_tags (lead_id, tag_id) SELECT $1, tag_id FROM lead_tags WHERE lead_id = ANY($2::bigint[]) ON CONFLICT DO NOTHING`,
      [primaryId, ids],
    );
    await addLeadEvent(primaryId, 'merged', { merged_ids: ids, names: others.map((o) => o.name) }, actor.id, db);
    await audit({ userId: actor.id, action: 'lead.merge', entityType: 'lead', entityId: primaryId, changes: { merged_ids: ids, filled: Object.keys(fill) } }, db);
    await publish({ type: 'lead.updated', leadId: primaryId }, db);
    return (await queryOne('SELECT * FROM leads WHERE id=$1', [primaryId], db))!;
  });
}

// ---------------------------------------------------------------------------
// Entrada de leads (fluxo comercial principal)
// ---------------------------------------------------------------------------

export interface IntakeInput extends Partial<LeadInput> {
  name?: string;
  course?: string | null; // código ou nome do curso
  campaign?: string | null; // nome da campanha (quando não há utm)
  message?: string | null; // mensagem enviada no formulário
  extra?: Record<string, unknown>; // demais dados recebidos (guardados no histórico)
}

export interface IntakeResult {
  leadId: number;
  created: boolean;
  opportunityId: number | null;
  ownerId: number | null;
  duplicateOf?: number;
}

async function resolveCourse(db: Queryable, input: IntakeInput) {
  if (input.course_id) {
    const c = await queryOne('SELECT id FROM courses WHERE id=$1', [input.course_id], db);
    return c?.id ?? null;
  }
  if (!input.course) return null;
  const c = await queryOne(
    `SELECT id FROM courses WHERE lower(code) = lower($1) OR lower(name) = lower($1) ORDER BY active DESC, id LIMIT 1`,
    [String(input.course).trim()],
    db,
  );
  return c?.id ?? null;
}

/**
 * Recebe um lead de qualquer canal (formulário, API, Meta Lead Ads, WhatsApp, importação).
 * 1. normaliza; 2. deduplica; 3. distribui; 4. cria oportunidade; 5. cria tarefa de primeiro contato; 6. notifica.
 */
export async function intakeLead(
  raw: IntakeInput,
  via: string,
  opts: { createOpportunity?: boolean; actor?: AuthUser | null; distribute?: boolean } = {},
): Promise<IntakeResult> {
  const phone = normalizePhone(raw.phone);
  const email = normalizeEmail(raw.email);
  if (!phone && !email) throw badRequest('Lead sem telefone ou e-mail válido');
  const name = (raw.name ?? '').toString().trim() || email || (phone ? `+${phone}` : 'Lead sem nome');
  const dist = await getSetting('distribution');

  return withTx(async (db) => {
    // trava por contato para impedir duplicidade em envios simultâneos do mesmo formulário
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead:${phone ?? email}`]);
    const courseId = await resolveCourse(db, raw);
    let campaignId = raw.campaign_id ?? null;
    if (!campaignId && !raw.utm_campaign && raw.campaign) {
      campaignId = await resolveCampaign(db, { utm_campaign: raw.campaign, utm_source: raw.utm_source ?? raw.source ?? null });
    }

    const existing = await findDuplicate(db, { phone, email });
    let lead: any;
    let created = false;
    if (existing) {
      // lead já existe: completa dados que faltam e registra nova entrada
      const fill: Record<string, unknown> = {};
      if (!existing.phone && phone) fill.phone = phone;
      if (!existing.email && email) fill.email = email;
      if (!existing.course_id && courseId) fill.course_id = courseId;
      for (const k of ['city', 'state', 'document'] as const) if (!existing[k] && raw[k]) fill[k] = raw[k];
      if (Object.keys(fill).length) {
        const cols = Object.keys(fill);
        await db.query(`UPDATE leads SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [existing.id, ...Object.values(fill)]);
      }
      if (raw.consent_whatsapp && !existing.consent_whatsapp) {
        await db.query('UPDATE leads SET consent_whatsapp=true, consent_at=now() WHERE id=$1', [existing.id]);
      }
      if (['lost', 'unqualified'].includes(existing.status)) {
        await changeLeadStatus(db, existing.id, 'new', null, { reason: 'reentry' });
      }
      await db.query('UPDATE leads SET reactivation_flag=false WHERE id=$1', [existing.id]);
      await addLeadEvent(existing.id, 'reentry', {
        via, source: raw.source ?? null, course_id: courseId, utm_campaign: raw.utm_campaign ?? null, utm_source: raw.utm_source ?? null,
        message: raw.message ?? null, extra: raw.extra ?? null,
      }, opts.actor?.id ?? null, db);
      lead = (await queryOne('SELECT * FROM leads WHERE id=$1', [existing.id], db))!;
      if (!lead.owner_id && dist.mode !== 'manual' && opts.distribute !== false) {
        const owner = await pickOwner(db);
        if (owner) await assignLead(db, lead.id, owner, null, 'distribution');
        lead.owner_id = owner;
      } else if (lead.owner_id) {
        await notifyUser({ userId: lead.owner_id, type: 'lead.reentry', title: 'Lead retornou com novo interesse', body: lead.name, link: `/leads/${lead.id}` }, db);
      }
    } else {
      lead = await insertLead(
        db,
        {
          ...(raw as any),
          name,
          phone,
          email,
          course_id: courseId,
          campaign_id: campaignId,
          tags: raw.tags,
          status: 'new',
          notes: raw.notes ?? (raw.message ? `Mensagem do formulário: ${raw.message}` : null),
        },
        { via, distribute: opts.distribute !== false, actor: opts.actor ?? null },
      );
      created = true;
      if (raw.extra && Object.keys(raw.extra).length) await addLeadEvent(lead.id, 'intake_data', { via, extra: raw.extra }, null, db);
      if (lead.owner_id) {
        await notifyUser({ userId: lead.owner_id, type: 'lead.new', title: 'Novo lead para você', body: lead.name, link: `/leads/${lead.id}` }, db);
      } else {
        await notifyManagers({ type: 'lead.unassigned', title: 'Novo lead sem responsável', body: lead.name, link: `/leads/${lead.id}` }, null, db);
      }
    }

    // oportunidade: cria se não houver uma aberta para o mesmo curso
    let opportunityId: number | null = null;
    const shouldCreateOpp = opts.createOpportunity ?? dist.auto_create_opportunity;
    if (shouldCreateOpp) {
      const open = await queryOne(
        `SELECT id FROM opportunities WHERE lead_id=$1 AND status='open' AND (course_id IS NOT DISTINCT FROM $2 OR $2::bigint IS NULL) LIMIT 1`,
        [lead.id, courseId],
        db,
      );
      if (open) opportunityId = open.id;
      else {
        const opp = await createOpportunity(db, { lead_id: lead.id, course_id: courseId ?? lead.course_id, owner_id: lead.owner_id, campaign_id: campaignId ?? lead.campaign_id, source: raw.source ?? lead.source }, null);
        opportunityId = opp.id;
      }
    }

    // tarefa de primeiro contato
    if (dist.auto_first_contact_task && lead.owner_id && !lead.first_contact_at) {
      const pending = await queryOne(`SELECT id FROM tasks WHERE lead_id=$1 AND type='first_contact' AND status='pending'`, [lead.id], db);
      if (!pending) {
        await createTask(db, {
          type: 'first_contact',
          title: `Primeiro contato com ${lead.name}`,
          lead_id: lead.id,
          opportunity_id: opportunityId,
          assignee_id: lead.owner_id,
          due_at: new Date(Date.now() + (dist.first_contact_task_minutes ?? 15) * 60_000).toISOString(),
          source: 'automation',
        }, null);
      }
    }

    return { leadId: lead.id, created, opportunityId, ownerId: lead.owner_id ?? null, duplicateOf: created ? undefined : lead.id };
  });
}
