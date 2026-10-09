import { createReadStream, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, Sql, withTx } from '../db/pool.js';
import { assertLeadAccess, AuthUser, conversationScope, currentUser, isManager } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { publish } from '../lib/realtime.js';
import { parse } from '../lib/validate.js';
import { assignConversation, closeConversation, getOrCreateConversation, reopenConversation, windowExpiresAt, windowOpen } from '../services/conversations.js';
import { intakeLead } from '../services/leads.js';
import { defaultWaAccount, getWaAccount } from '../services/meta/app.js';
import { MEDIA_DIR } from '../services/whatsapp/media.js';
import { mediaTypeForMime, resendMessage, sendMessage } from '../services/whatsapp/outbound.js';
import { addLeadEvent } from '../services/timeline.js';

async function loadConversation(u: AuthUser, id: number) {
  const sql = new Sql([id]);
  const scope = await conversationScope(u, sql);
  const c = await queryOne(`SELECT c.* FROM conversations c WHERE c.id=$1 AND ${scope}`, sql.params);
  if (!c) {
    const exists = await queryOne('SELECT id FROM conversations WHERE id=$1', [id]);
    throw exists ? forbidden('Você não tem acesso a esta conversa') : notFound('Conversa não encontrada');
  }
  return c;
}

const CONV_SELECT = `
  SELECT c.id, c.wa_account_id, c.lead_id, c.contact_wa_id, c.contact_name, c.status, c.assignee_id, c.unread_count, c.awaiting_reply, c.awaiting_since,
         c.last_message_at, c.last_message_preview, c.last_inbound_at, c.closed_at, c.created_at,
         l.name AS lead_name, l.status AS lead_status, l.owner_id AS lead_owner_id, u.name AS assignee_name, a.display_phone AS account_phone, a.name AS account_name,
         ARRAY(SELECT tag_id FROM conversation_tags ct WHERE ct.conversation_id=c.id) AS tag_ids
    FROM conversations c
    LEFT JOIN leads l ON l.id=c.lead_id
    LEFT JOIN users u ON u.id=c.assignee_id
    JOIN wa_accounts a ON a.id=c.wa_account_id`;

async function convWhere(u: AuthUser, q: Record<string, string>) {
  const sql = new Sql();
  sql.and(await conversationScope(u, sql));
  sql.and(`c.contact_wa_id NOT LIKE 'anon-%'`);
  switch (q.filter) {
    case 'open':
      sql.and(`c.status='open'`);
      break;
    case 'pending':
      sql.and(`c.status='pending'`);
      break;
    case 'closed':
      sql.and(`c.status='closed'`);
      break;
    case 'unassigned':
      sql.and(`c.assignee_id IS NULL AND c.status<>'closed'`);
      break;
    case 'mine':
      sql.and(`c.assignee_id=${sql.p(u.id)} AND c.status<>'closed'`);
      break;
    case 'awaiting':
      sql.and(`c.awaiting_reply AND c.status<>'closed'`);
      break;
    case 'unread':
      sql.and(`c.unread_count > 0`);
      break;
    default:
      if (q.filter !== 'all') sql.and(`c.status<>'closed'`);
  }
  if (q.assignee_id) sql.and(`c.assignee_id = ${sql.p(Number(q.assignee_id))}`);
  if (q.account_id) sql.and(`c.wa_account_id = ${sql.p(Number(q.account_id))}`);
  if (q.tag_id) sql.and(`EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id=c.id AND ct.tag_id=${sql.p(Number(q.tag_id))})`);
  if (q.q?.trim()) {
    const term = q.q.trim();
    const digits = term.replace(/\D/g, '');
    const like = sql.p(`%${term}%`);
    const parts = [`c.contact_name ILIKE ${like}`, `l.name ILIKE ${like}`, `EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.body ILIKE ${like})`];
    if (digits.length >= 4) parts.push(`c.contact_wa_id LIKE ${sql.p(`%${digits}%`)}`);
    sql.and(`(${parts.join(' OR ')})`);
  }
  return sql;
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    const u = currentUser(req);
    const q = req.query as Record<string, string>;
    const sql = await convWhere(u, q);
    const limit = Math.min(100, Number(q.limit ?? 40));
    if (q.before) sql.and(`c.last_message_at < ${sql.p(q.before)}::timestamptz`);
    const rows = (await pool.query(`${CONV_SELECT} ${sql.whereSql()} ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC LIMIT ${limit}`, sql.params)).rows;
    return { rows: rows.map((r) => ({ ...r, window_open: windowOpen(r.last_inbound_at) })), hasMore: rows.length === limit };
  });

  app.get('/api/conversations/counts', async (req) => {
    const u = currentUser(req);
    const sql = new Sql();
    sql.and(await conversationScope(u, sql));
    const me = sql.p(u.id);
    return queryOne(
      `SELECT count(*) FILTER (WHERE c.status='open')::int AS open,
              count(*) FILTER (WHERE c.status='pending')::int AS pending,
              count(*) FILTER (WHERE c.assignee_id IS NULL AND c.status<>'closed')::int AS unassigned,
              count(*) FILTER (WHERE c.assignee_id=${me} AND c.status<>'closed')::int AS mine,
              count(*) FILTER (WHERE c.awaiting_reply AND c.status<>'closed')::int AS awaiting,
              COALESCE(sum(c.unread_count) FILTER (WHERE c.status<>'closed'),0)::int AS unread
         FROM conversations c ${sql.whereSql()}`,
      sql.params,
    );
  });

  app.get('/api/conversations/:id', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const c = await queryOne(`${CONV_SELECT} WHERE c.id=$1`, [id]);
    return { ...c, window_open: windowOpen(c.last_inbound_at), window_expires_at: windowExpiresAt(c.last_inbound_at) };
  });

  app.get('/api/conversations/:id/messages', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const q = req.query as { before_id?: string; after_id?: string; limit?: string };
    const limit = Math.min(200, Number(q.limit ?? 60));
    let rows;
    if (q.after_id) {
      rows = (await pool.query(
        `SELECT m.id, m.direction, m.wamid, m.type, m.body, m.media_mime, m.media_filename, m.media_status, m.media_size, (m.media_path IS NOT NULL) AS has_media,
                m.template_name, m.status, m.error, m.sender_id, u.name AS sender_name, m.origin, m.reply_to_wamid, m.sent_at, m.status_at
           FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=$1 AND m.id > $2 ORDER BY m.sent_at, m.id LIMIT $3`,
        [id, Number(q.after_id), limit],
      )).rows;
      return { rows, hasMore: false };
    }
    rows = (await pool.query(
      `SELECT * FROM (
         SELECT m.id, m.direction, m.wamid, m.type, m.body, m.media_mime, m.media_filename, m.media_status, m.media_size, (m.media_path IS NOT NULL) AS has_media,
                m.template_name, m.status, m.error, m.sender_id, u.name AS sender_name, m.origin, m.reply_to_wamid, m.sent_at, m.status_at
           FROM messages m LEFT JOIN users u ON u.id=m.sender_id
          WHERE m.conversation_id=$1 AND ($2::bigint IS NULL OR (m.sent_at, m.id) < (SELECT sent_at, id FROM messages WHERE id=$2))
          ORDER BY m.sent_at DESC, m.id DESC LIMIT $3) x
       ORDER BY sent_at ASC, id ASC`,
      [id, q.before_id ? Number(q.before_id) : null, limit],
    )).rows;
    return { rows, hasMore: rows.length === limit };
  });

  app.post('/api/conversations/:id/read', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    if (c.unread_count > 0) {
      await pool.query('UPDATE conversations SET unread_count=0 WHERE id=$1', [id]);
      await publish({ type: 'conversation.updated', conversationId: id, users: [u.id], managers: true });
    }
    return { ok: true };
  });

  app.post('/api/conversations/:id/messages', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    const body = parse(z.object({ text: z.string().min(1).max(4096), reply_to: z.string().optional().nullable() }), req.body);
    if (!c.assignee_id && !isManager(u)) await assignConversation(pool, id, u.id, u.id);
    return sendMessage(id, { kind: 'text', body: body.text, replyTo: body.reply_to }, u);
  });

  app.post('/api/conversations/:id/media', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const file = await req.file();
    if (!file) throw badRequest('Selecione um arquivo');
    const buf = await file.toBuffer();
    const caption = ((file.fields as any).caption?.value as string | undefined)?.slice(0, 1024) || null;
    const mime = file.mimetype || 'application/octet-stream';
    const forceDoc = (file.fields as any).as_document?.value === 'true';
    const mediaType = forceDoc ? 'document' : mediaTypeForMime(mime);
    return sendMessage(id, { kind: 'media', mediaType, file: buf, mime, filename: file.filename || 'arquivo', caption }, u);
  });

  app.post('/api/conversations/:id/template', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const body = parse(
      z.object({
        name: z.string().min(1),
        language: z.string().min(2),
        body_params: z.array(z.string().min(1, 'Preencha todas as variáveis do modelo').max(1024)).default([]),
        header_params: z.array(z.string().min(1).max(60)).default([]),
      }),
      req.body,
    );
    const components: any[] = [];
    if (body.header_params.length) components.push({ type: 'header', parameters: body.header_params.map((t) => ({ type: 'text', text: t })) });
    if (body.body_params.length) components.push({ type: 'body', parameters: body.body_params.map((t) => ({ type: 'text', text: t })) });
    return sendMessage(id, { kind: 'template', name: body.name, language: body.language, components }, u);
  });

  app.post('/api/conversations/:id/notes', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(5000) }), req.body);
    const m = await queryOne(`INSERT INTO messages (conversation_id, direction, type, body, status, sender_id) VALUES ($1,'note','note',$2,'note',$3) RETURNING *`, [id, body.text, u.id]);
    if (c.lead_id) await addLeadEvent(c.lead_id, 'note', { text: body.text, conversation_id: id }, u.id);
    await publish({ type: 'message.created', id: m!.id, conversationId: id, users: c.assignee_id ? [c.assignee_id] : undefined, managers: true });
    return m;
  });

  app.post('/api/conversations/:id/assign', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    const body = parse(z.object({ assignee_id: z.number().int().nullable(), transfer_lead: z.boolean().default(true), note: z.string().max(500).optional().nullable() }), req.body);
    // vendedor pode assumir conversa sem responsável ou transferir as suas
    if (!isManager(u) && c.assignee_id && c.assignee_id !== u.id) throw forbidden('Você só pode transferir conversas sob sua responsabilidade');
    return withTx((db) => assignConversation(db, id, body.assignee_id, u.id, { transferLead: body.transfer_lead, note: body.note }));
  });

  app.post('/api/conversations/:id/close', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const body = parse(z.object({ reason: z.string().max(500).optional().nullable() }), req.body ?? {});
    await withTx((db) => closeConversation(db, id, u.id, body.reason));
    return { ok: true };
  });

  app.post('/api/conversations/:id/reopen', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    await withTx((db) => reopenConversation(db, id, u.id));
    return { ok: true };
  });

  app.post('/api/conversations/:id/status', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    const body = parse(z.object({ status: z.enum(['open', 'pending']) }), req.body);
    if (c.status === 'closed') throw badRequest('Reabra o atendimento antes de alterar o status');
    await pool.query('UPDATE conversations SET status=$2, updated_at=now() WHERE id=$1', [id, body.status]);
    await publish({ type: 'conversation.updated', conversationId: id, managers: true, users: c.assignee_id ? [c.assignee_id] : undefined });
    return { ok: true };
  });

  app.put('/api/conversations/:id/tags', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    await loadConversation(u, id);
    const body = parse(z.object({ tag_ids: z.array(z.number().int()) }), req.body);
    await withTx(async (db) => {
      await db.query('DELETE FROM conversation_tags WHERE conversation_id=$1', [id]);
      if (body.tag_ids.length) await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [id, body.tag_ids]);
    });
    await publish({ type: 'conversation.updated', conversationId: id, managers: true });
    return { ok: true };
  });

  /** Vincula a conversa a um lead existente ou cria um lead a partir do contato */
  app.post('/api/conversations/:id/lead', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const c = await loadConversation(u, id);
    const body = parse(z.object({ lead_id: z.number().int().optional(), name: z.string().trim().min(1).max(200).optional() }), req.body);
    let leadId = body.lead_id;
    if (leadId) await assertLeadAccess(u, leadId);
    else {
      const r = await intakeLead({ name: body.name ?? c.contact_name ?? undefined, phone: `+${c.contact_wa_id}`, source: 'WhatsApp', owner_id: c.assignee_id ?? u.id }, 'whatsapp', { actor: u });
      leadId = r.leadId;
    }
    await pool.query('UPDATE conversations SET lead_id=$2, updated_at=now() WHERE id=$1', [id, leadId]);
    await publish({ type: 'conversation.updated', conversationId: id, managers: true });
    return { lead_id: leadId };
  });

  app.post('/api/messages/:id/resend', async (req) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const m = await queryOne('SELECT conversation_id FROM messages WHERE id=$1', [id]);
    if (!m) throw notFound('Mensagem não encontrada');
    await loadConversation(u, m.conversation_id);
    return resendMessage(id, u);
  });

  app.get('/api/messages/:id/media', async (req, reply) => {
    const u = currentUser(req);
    const id = Number((req.params as any).id);
    const m = await queryOne('SELECT conversation_id, media_path, media_mime, media_filename FROM messages WHERE id=$1', [id]);
    if (!m || !m.media_path) throw notFound('Arquivo não disponível');
    await loadConversation(u, m.conversation_id);
    const full = normalize(join(MEDIA_DIR, m.media_path));
    if (!full.startsWith(MEDIA_DIR) || !existsSync(full)) throw notFound('Arquivo não encontrado no armazenamento');
    reply.header('Content-Type', m.media_mime || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=86400');
    const dl = (req.query as any).download === '1';
    reply.header('Content-Disposition', `${dl ? 'attachment' : 'inline'}; filename="${encodeURIComponent(m.media_filename || `arquivo-${id}`)}"`);
    return reply.send(createReadStream(full));
  });

  /** Abre (ou cria) a conversa de WhatsApp de um lead — para iniciar atendimento com modelo aprovado */
  app.post('/api/leads/:id/conversation', async (req) => {
    const u = currentUser(req);
    const leadId = Number((req.params as any).id);
    await assertLeadAccess(u, leadId);
    const body = parse(z.object({ account_id: z.number().int().optional() }), req.body ?? {});
    const lead = await queryOne('SELECT id, name, phone, owner_id FROM leads WHERE id=$1', [leadId]);
    const phone = normalizePhone(lead?.phone);
    if (!phone) throw badRequest('O lead não possui telefone válido para WhatsApp');
    const account = body.account_id ? await getWaAccount(body.account_id) : await defaultWaAccount();
    if (!account) throw badRequest('Nenhuma conta de WhatsApp configurada. Conecte uma conta em Integrações.');
    const existing = await queryOne(`SELECT id FROM conversations WHERE lead_id=$1 AND wa_account_id=$2 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [leadId, account.id]);
    if (existing) return { id: existing.id };
    const conv = await withTx(async (db) => {
      const c = await getOrCreateConversation(db, account.id, phone, { leadId, contactName: lead!.name });
      if (!c.assignee_id) await db.query('UPDATE conversations SET assignee_id=$2 WHERE id=$1', [c.id, lead!.owner_id ?? u.id]);
      return c;
    });
    return { id: conv.id };
  });

  app.get('/api/wa/templates', async (req) => {
    currentUser(req);
    const q = req.query as { account_id?: string };
    return (await pool.query(
      `SELECT t.id, t.wa_account_id, t.name, t.language, t.category, t.status, t.components FROM wa_templates t
        WHERE ($1::bigint IS NULL OR t.wa_account_id=$1) ORDER BY (t.status='APPROVED') DESC, t.name`,
      [q.account_id ? Number(q.account_id) : null],
    )).rows;
  });
}
