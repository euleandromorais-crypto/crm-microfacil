import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, queryOne, withTx } from '../../db/pool.js';
import type { AuthUser } from '../../lib/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { enqueue } from '../../lib/jobs.js';
import { publish } from '../../lib/realtime.js';
import { windowOpen } from '../conversations.js';
import { logIntegration } from '../integrationLog.js';
import { touchLeadInteraction } from '../leads.js';
import { getWaAccount } from '../meta/app.js';
import { graph, GraphError } from '../meta/graph.js';
import { addLeadEvent } from '../timeline.js';
import { MEDIA_DIR, saveMediaFile } from './media.js';

export type OutgoingMessage =
  | { kind: 'text'; body: string; replyTo?: string | null }
  | { kind: 'media'; mediaType: 'image' | 'audio' | 'video' | 'document'; file: Buffer; mime: string; filename: string; caption?: string | null }
  | { kind: 'template'; name: string; language: string; components?: any[]; preview?: string | null };

const MEDIA_LIMITS_MB: Record<string, number> = { image: 5, audio: 16, video: 16, document: 100 };

export function mediaTypeForMime(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image';
  if (/^audio\/(aac|amr|mpeg|mp4|ogg)/.test(mime)) return 'audio';
  if (/^video\/(mp4|3gpp)$/.test(mime)) return 'video';
  return 'document';
}

/** Monta o texto exibido no CRM para um template, substituindo {{n}} pelos parâmetros enviados */
export function renderTemplatePreview(components: any[] | undefined, templateComponents: any[] | undefined, name: string) {
  const body = (templateComponents ?? []).find((c: any) => c.type === 'BODY')?.text as string | undefined;
  if (!body) return `Modelo: ${name}`;
  const params = (components ?? []).find((c: any) => c.type === 'body')?.parameters ?? [];
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1]?.text ?? `{{${n}}}`);
}

/**
 * Envia mensagem pela Cloud API.
 * - Mensagens livres só dentro da janela de 24h após a última mensagem do cliente.
 * - Fora da janela, somente modelos (templates) aprovados.
 * A mensagem é gravada antes do envio (status queued) para nunca se perder do histórico.
 */
export async function sendMessage(conversationId: number, msg: OutgoingMessage, actor: AuthUser | null, origin = 'crm') {
  const conv = await queryOne('SELECT * FROM conversations WHERE id=$1', [conversationId]);
  if (!conv) throw notFound('Conversa não encontrada');
  const account = await getWaAccount(conv.wa_account_id);
  if (account.status === 'disabled') throw badRequest('A conta de WhatsApp desta conversa está desativada');

  if (msg.kind !== 'template' && !windowOpen(conv.last_inbound_at)) {
    throw badRequest('A janela de 24 horas de atendimento está fechada. Envie um modelo (template) aprovado pela Meta para retomar a conversa.', {
      code: 'window_closed',
    });
  }
  if (msg.kind === 'text' && !msg.body.trim()) throw badRequest('Mensagem vazia');
  if (msg.kind === 'text' && msg.body.length > 4096) throw badRequest('Mensagem muito longa (máximo 4096 caracteres)');
  if (msg.kind === 'media') {
    const limit = MEDIA_LIMITS_MB[msg.mediaType];
    if (msg.file.length > limit * 1024 * 1024) throw badRequest(`Arquivo excede o limite de ${limit} MB para ${msg.mediaType}`);
  }

  let tpl: any = null;
  if (msg.kind === 'template') {
    tpl = await queryOne(`SELECT * FROM wa_templates WHERE wa_account_id=$1 AND name=$2 AND language=$3`, [account.id, msg.name, msg.language]);
    if (!tpl) throw badRequest('Modelo não encontrado. Sincronize os modelos da conta.');
    if (tpl.status !== 'APPROVED') throw badRequest(`Modelo não está aprovado pela Meta (status: ${tpl.status})`);
  }

  const preview =
    msg.kind === 'text' ? msg.body : msg.kind === 'media' ? msg.caption || msg.filename : msg.preview ?? renderTemplatePreview(msg.components, tpl?.components, msg.name);
  const type = msg.kind === 'text' ? 'text' : msg.kind === 'media' ? msg.mediaType : 'template';

  const row = (await queryOne(
    `INSERT INTO messages (conversation_id, direction, type, body, media_mime, media_filename, media_status, template_name, status, sender_id, origin, reply_to_wamid, sent_at)
     VALUES ($1,'out',$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,now()) RETURNING *`,
    [conversationId, type, msg.kind === 'media' ? msg.caption ?? null : preview, msg.kind === 'media' ? msg.mime : null, msg.kind === 'media' ? msg.filename : null,
      msg.kind === 'media' ? 'ready' : null, msg.kind === 'template' ? msg.name : null, actor?.id ?? null, origin, msg.kind === 'text' ? msg.replyTo ?? null : null],
  ))!;
  if (msg.kind === 'media') {
    const rel = await saveMediaFile(row.id, msg.file, msg.mime, msg.filename);
    await pool.query('UPDATE messages SET media_path=$2, media_size=$3 WHERE id=$1', [row.id, rel, msg.file.length]);
  }
  await publish({ type: 'message.created', id: row.id, conversationId, users: conv.assignee_id ? [conv.assignee_id] : undefined, managers: true });

  // serializa o payload para permitir reenvio
  const payload = await buildPayload(account, conv.contact_wa_id, msg, row.id);
  return deliver(row.id, payload, actor?.id ?? null);
}

async function buildPayload(account: { phone_number_id: string; access_token: string }, to: string, msg: OutgoingMessage, messageId: number) {
  const base: any = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (msg.kind === 'text') {
    return { ...base, type: 'text', text: { body: msg.body, preview_url: /https?:\/\//.test(msg.body) }, ...(msg.replyTo ? { context: { message_id: msg.replyTo } } : {}) };
  }
  if (msg.kind === 'template') {
    return { ...base, type: 'template', template: { name: msg.name, language: { code: msg.language }, components: msg.components ?? [] } };
  }
  // mídia: upload para a Meta e envio pelo id
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', msg.mime);
  form.append('file', new Blob([new Uint8Array(msg.file)], { type: msg.mime }), msg.filename);
  const up = await graph<{ id: string }>(`${account.phone_number_id}/media`, { method: 'POST', token: account.access_token, form, timeoutMs: 120_000 });
  await pool.query('UPDATE messages SET media_id=$2 WHERE id=$1', [messageId, up.id]);
  const media: any = { id: up.id };
  if (msg.caption && msg.mediaType !== 'audio') media.caption = msg.caption;
  if (msg.mediaType === 'document') media.filename = msg.filename;
  return { ...base, type: msg.mediaType, [msg.mediaType]: media };
}

/** Executa a chamada de envio e atualiza o registro da mensagem */
export async function deliver(messageId: number, payload: any, actorId: number | null) {
  const msg = await queryOne(
    `SELECT m.*, c.wa_account_id, c.lead_id, c.assignee_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1`,
    [messageId],
  );
  if (!msg) throw notFound('Mensagem não encontrada');
  const account = await getWaAccount(msg.wa_account_id);
  try {
    const res = await graph<{ messages: { id: string }[] }>(`${account.phone_number_id}/messages`, { method: 'POST', token: account.access_token, json: payload });
    const wamid = res.messages?.[0]?.id;
    await withTx(async (db) => {
      await db.query(`UPDATE messages SET wamid=$2, status='sent', status_at=now(), error=NULL WHERE id=$1`, [messageId, wamid]);
      await db.query(
        `UPDATE conversations SET awaiting_reply=false, awaiting_since=NULL, unread_count=0,
           first_response_at=COALESCE(first_response_at, now()),
           last_message_at=now(), last_message_preview=$2,
           status = CASE WHEN status='closed' THEN 'open' ELSE status END, updated_at=now()
         WHERE id=$1`,
        [msg.conversation_id, `Você: ${msg.body ?? msg.media_filename ?? msg.type}`.slice(0, 200)],
      );
      await db.query(
        `UPDATE conversation_sessions SET first_response_at = COALESCE(first_response_at, now())
          WHERE id = (SELECT id FROM conversation_sessions WHERE conversation_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`,
        [msg.conversation_id],
      );
      if (msg.lead_id) {
        await touchLeadInteraction(db, msg.lead_id, 'out', new Date(), actorId);
        const recent = await queryOne(
          `SELECT id FROM lead_events WHERE lead_id=$1 AND type='whatsapp_out' AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`,
          [msg.lead_id],
          db,
        );
        const preview = (msg.body ?? msg.media_filename ?? msg.type ?? '').slice(0, 200);
        if (recent) {
          await db.query(`UPDATE lead_events SET data = jsonb_set(jsonb_set(data,'{count}', to_jsonb(COALESCE((data->>'count')::int,1)+1)), '{last}', to_jsonb($2::text)) WHERE id=$1`, [recent.id, preview]);
        } else {
          await addLeadEvent(msg.lead_id, 'whatsapp_out', { conversation_id: msg.conversation_id, first: preview, last: preview, count: 1, template: msg.template_name }, actorId, db);
        }
      }
    });
    await publish({ type: 'message.status', id: messageId, conversationId: msg.conversation_id, managers: true, users: msg.assignee_id ? [msg.assignee_id] : undefined });
    await publish({ type: 'conversation.updated', conversationId: msg.conversation_id, managers: true, users: msg.assignee_id ? [msg.assignee_id] : undefined });
    return (await queryOne('SELECT * FROM messages WHERE id=$1', [messageId]))!;
  } catch (err) {
    const ge = err instanceof GraphError ? err : new GraphError((err as Error).message, 0);
    const errorInfo = { message: ge.message, code: ge.code, subcode: ge.subcode, fbtrace_id: ge.fbtraceId };
    if (ge.transient && msg.status === 'queued') {
      // falha temporária: re-tenta em segundo plano
      await pool.query(`UPDATE messages SET error=$2 WHERE id=$1`, [messageId, JSON.stringify({ ...errorInfo, retrying: true })]);
      await enqueue('wa.send.retry', { messageId, payload, actorId }, { delayMs: 30_000, maxAttempts: 4, dedupeKey: `wa-send-${messageId}` });
    } else {
      await pool.query(`UPDATE messages SET status='failed', status_at=now(), error=$2 WHERE id=$1`, [messageId, JSON.stringify(errorInfo)]);
    }
    await logIntegration(`whatsapp:${account.id}`, 'error', 'send', `Falha ao enviar mensagem #${messageId}: ${ge.message}`, errorInfo);
    await publish({ type: 'message.status', id: messageId, conversationId: msg.conversation_id, managers: true, users: msg.assignee_id ? [msg.assignee_id] : undefined });
    const out = (await queryOne('SELECT * FROM messages WHERE id=$1', [messageId]))!;
    if (!ge.transient) throw badRequest(`O WhatsApp recusou a mensagem: ${ge.message}`, { message: out });
    return out;
  }
}

/** Job de re-tentativa de envio */
export async function retrySendJob(p: { messageId: number; payload: any; actorId: number | null }, job: { attempts: number }) {
  const msg = await queryOne('SELECT status FROM messages WHERE id=$1', [p.messageId]);
  if (!msg || msg.status !== 'queued') return;
  const out = await deliver(p.messageId, p.payload, p.actorId).catch(() => null);
  if (out?.status === 'queued' && job.attempts >= 4) {
    await pool.query(`UPDATE messages SET status='failed', status_at=now() WHERE id=$1`, [p.messageId]);
  } else if (out?.status === 'queued') {
    throw new Error('Envio ainda pendente');
  }
}

/** Reenvio manual de uma mensagem que falhou */
export async function resendMessage(messageId: number, actor: AuthUser) {
  const msg = await queryOne(
    `SELECT m.*, c.contact_wa_id, c.wa_account_id, c.last_inbound_at FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1`,
    [messageId],
  );
  if (!msg) throw notFound('Mensagem não encontrada');
  if (msg.direction !== 'out' || msg.status !== 'failed') throw badRequest('Somente mensagens enviadas com falha podem ser reenviadas');
  if (msg.type === 'template') throw badRequest('Para modelos, envie novamente pelo seletor de modelos');
  if (!windowOpen(msg.last_inbound_at)) throw badRequest('A janela de 24 horas está fechada. Envie um modelo aprovado.');
  const account = await getWaAccount(msg.wa_account_id);
  let out: OutgoingMessage;
  if (msg.type === 'text') out = { kind: 'text', body: msg.body };
  else {
    if (!msg.media_path) throw badRequest('Arquivo original não encontrado para reenvio');
    const file = await readFile(join(MEDIA_DIR, msg.media_path));
    out = { kind: 'media', mediaType: msg.type, file, mime: msg.media_mime, filename: msg.media_filename ?? 'arquivo', caption: msg.body };
  }
  await pool.query(`UPDATE messages SET status='queued', error=NULL WHERE id=$1`, [messageId]);
  const payload = await buildPayload(account, msg.contact_wa_id, out, messageId);
  return deliver(messageId, payload, actor.id);
}
