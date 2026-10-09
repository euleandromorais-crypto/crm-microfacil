import { pool, queryOne, withTx } from '../../db/pool.js';
import { enqueue, PermanentError } from '../../lib/jobs.js';
import { normalizePhone, phoneVariants } from '../../lib/phone.js';
import { publish } from '../../lib/realtime.js';
import { getSetting } from '../../lib/settings.js';
import { ensureConversationAssignee, getOrCreateConversation, reopenConversation } from '../conversations.js';
import { emitDomainEvent } from '../domainEvents.js';
import { logIntegration } from '../integrationLog.js';
import { intakeLead, touchLeadInteraction } from '../leads.js';
import { getWaAccountByPhoneNumberId } from '../meta/app.js';
import { addLeadEvent } from '../timeline.js';
import { isMediaType, parseWaMessage, STATUS_RANK } from './parse.js';

type WaAccount = NonNullable<Awaited<ReturnType<typeof getWaAccountByPhoneNumberId>>>;

async function findLeadByPhone(phone: string) {
  return queryOne(
    `SELECT id, owner_id FROM leads WHERE deleted_at IS NULL AND phone = ANY($1::text[]) ORDER BY created_at LIMIT 1`,
    [phoneVariants(phone)],
  );
}

/** Lead vinculado ao número; cria automaticamente se configurado */
async function resolveLead(waId: string, profileName: string | null, allowCreate: boolean) {
  const phone = normalizePhone(`+${waId}`) ?? waId;
  const found = await findLeadByPhone(phone);
  if (found) return found.id as number;
  if (!allowCreate) return null;
  const cfg = await getSetting('whatsapp');
  if (!cfg.auto_create_lead) return null;
  const r = await intakeLead({ name: profileName ?? undefined, phone: `+${waId}`, source: cfg.default_source || 'WhatsApp' }, 'whatsapp');
  return r.leadId;
}

/** Throttle: um evento de linha do tempo por lead/direção a cada 30 min, para não poluir o histórico */
async function timelineMessage(db: any, leadId: number, direction: 'in' | 'out', preview: string, conversationId: number, userId: number | null, at: Date) {
  const type = direction === 'in' ? 'whatsapp_in' : 'whatsapp_out';
  const recent = await queryOne(
    `SELECT id FROM lead_events WHERE lead_id=$1 AND type=$2 AND created_at > $3::timestamptz - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`,
    [leadId, type, at],
    db,
  );
  if (recent) {
    await db.query(`UPDATE lead_events SET data = jsonb_set(jsonb_set(data, '{count}', to_jsonb(COALESCE((data->>'count')::int,1)+1)), '{last}', to_jsonb($2::text)) WHERE id=$1`, [recent.id, preview]);
  } else {
    await addLeadEvent(leadId, type, { conversation_id: conversationId, first: preview, last: preview, count: 1 }, userId, db, at);
  }
}

/** Mensagem recebida do cliente */
export async function handleInboundMessage(account: WaAccount, m: any, contacts: any[]) {
  const wamid: string = m.id;
  if (await queryOne('SELECT id FROM messages WHERE wamid=$1', [wamid])) return 'duplicate';
  const waId: string = m.from;
  const profileName = contacts?.find((c) => c.wa_id === waId)?.profile?.name ?? null;
  const leadId = await resolveLead(waId, profileName, true);
  const parsed = parseWaMessage(m);
  const at = new Date(Number(m.timestamp) * 1000 || Date.now());
  const cfg = await getSetting('whatsapp');

  const result = await withTx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conv:${account.id}:${waId}`]);
    const conv = await getOrCreateConversation(db, account.id, waId, { leadId, contactName: profileName });
    if (conv.status === 'closed' && cfg.reopen_on_inbound) await reopenConversation(db, conv.id, null, true);

    // reações não contam como mensagem pendente
    const countsAsPending = parsed.type !== 'reaction';
    const ins = await queryOne(
      `INSERT INTO messages (conversation_id, direction, wamid, type, body, media_id, media_mime, media_filename, media_status,
          status, origin, reply_to_wamid, sent_at, raw)
       VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8,'received','customer',$9,$10,$11)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING RETURNING id`,
      [conv.id, wamid, parsed.type, parsed.body, parsed.media_id, parsed.media_mime, parsed.media_filename,
        parsed.media_id ? 'pending' : null, parsed.reply_to_wamid, at, JSON.stringify(m)],
      db,
    );
    if (!ins) return null;
    await db.query(
      `UPDATE conversations SET
         unread_count = unread_count + $2::int,
         awaiting_reply = CASE WHEN $3 THEN true ELSE awaiting_reply END,
         awaiting_since = CASE WHEN $3 THEN COALESCE(awaiting_since, $4) ELSE awaiting_since END,
         last_message_at = GREATEST(COALESCE(last_message_at, $4), $4),
         last_message_preview = CASE WHEN last_message_at IS NULL OR $4 >= last_message_at THEN $5 ELSE last_message_preview END,
         last_inbound_at = GREATEST(COALESCE(last_inbound_at, $4), $4),
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END,
         updated_at = now()
       WHERE id = $1`,
      [conv.id, countsAsPending ? 1 : 0, countsAsPending, at, parsed.preview],
    );
    const assignee = await ensureConversationAssignee(db, conv.id);
    if (conv.lead_id ?? leadId) {
      const lid = (conv.lead_id ?? leadId) as number;
      await touchLeadInteraction(db, lid, 'in', at);
      await timelineMessage(db, lid, 'in', parsed.preview, conv.id, null, at);
      await emitDomainEvent({ type: 'message.received', conversationId: conv.id, leadId: lid, data: { type: parsed.type } }, db);
    }
    if (parsed.media_id) await enqueue('wa.media.download', { messageId: ins.id }, { maxAttempts: 6 }, db);
    await publish({ type: 'message.created', id: ins.id, conversationId: conv.id, users: assignee ? [assignee] : undefined, managers: true }, db);
    await publish({ type: 'conversation.updated', conversationId: conv.id, users: assignee ? [assignee] : undefined, managers: true }, db);
    return ins.id as number;
  });
  return result ? 'stored' : 'duplicate';
}

/** Atualização de status de mensagem enviada (sent/delivered/read/failed) */
export async function handleStatus(account: WaAccount, s: any, attempt: number) {
  const msg = await queryOne('SELECT id, status, conversation_id FROM messages WHERE wamid=$1', [s.id]);
  if (!msg) {
    // o status pode chegar antes de gravarmos o wamid do envio; tentamos de novo algumas vezes
    if (attempt < 3) throw new Error(`Mensagem ${s.id} ainda não registrada para atualizar status`);
    return 'unknown';
  }
  const newRank = STATUS_RANK[s.status] ?? -1;
  const curRank = STATUS_RANK[msg.status] ?? -1;
  const at = new Date(Number(s.timestamp) * 1000 || Date.now());
  if (s.status === 'failed') {
    if (['delivered', 'read'].includes(msg.status)) return 'ignored';
  } else if (newRank <= curRank) return 'ignored';
  const error = s.errors?.length ? JSON.stringify(s.errors) : null;
  await pool.query('UPDATE messages SET status=$2, status_at=$3, error=COALESCE($4::jsonb, error) WHERE id=$1', [msg.id, s.status, at, error]);
  if (s.status === 'failed') {
    await logIntegration(`whatsapp:${account.id}`, 'warn', 'message.failed', `Falha na entrega da mensagem ${s.id}: ${s.errors?.[0]?.title ?? s.errors?.[0]?.message ?? ''}`, s.errors);
  }
  await publish({ type: 'message.status', id: msg.id, conversationId: msg.conversation_id, managers: true });
  return 'updated';
}

/**
 * Coexistência — mensagem enviada pela empresa a partir do app WhatsApp Business no celular.
 * Registrada como mensagem de saída para manter o histórico completo no CRM.
 */
export async function handleEcho(account: WaAccount, m: any) {
  if (!m?.id) return 'invalid';
  if (await queryOne('SELECT id FROM messages WHERE wamid=$1', [m.id])) return 'duplicate';
  const waId: string = m.to;
  const leadId = await resolveLead(waId, null, false);
  const parsed = parseWaMessage(m);
  const at = new Date(Number(m.timestamp) * 1000 || Date.now());
  await withTx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conv:${account.id}:${waId}`]);
    const conv = await getOrCreateConversation(db, account.id, waId, { leadId });
    const ins = await queryOne(
      `INSERT INTO messages (conversation_id, direction, wamid, type, body, media_id, media_mime, media_filename, media_status, status, origin, sent_at, raw)
       VALUES ($1,'out',$2,$3,$4,$5,$6,$7,$8,'sent','phone_app',$9,$10)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING RETURNING id`,
      [conv.id, m.id, parsed.type, parsed.body, parsed.media_id, parsed.media_mime, parsed.media_filename, parsed.media_id ? 'pending' : null, at, JSON.stringify(m)],
      db,
    );
    if (!ins) return;
    await db.query(
      `UPDATE conversations SET awaiting_reply=false, awaiting_since=NULL, unread_count=0,
         first_response_at = COALESCE(first_response_at, $2),
         last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
         last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END,
         updated_at=now()
       WHERE id=$1`,
      [conv.id, at, `Você (celular): ${parsed.preview}`.slice(0, 200)],
    );
    await db.query(
      `UPDATE conversation_sessions SET first_response_at = COALESCE(first_response_at, $2)
        WHERE id = (SELECT id FROM conversation_sessions WHERE conversation_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`,
      [conv.id, at],
    );
    const lid = conv.lead_id ?? leadId;
    if (lid) {
      await touchLeadInteraction(db, lid, 'out', at);
      await timelineMessage(db, lid, 'out', parsed.preview, conv.id, null, at);
    }
    if (parsed.media_id) await enqueue('wa.media.download', { messageId: ins.id }, { maxAttempts: 6 }, db);
    await publish({ type: 'message.created', id: ins.id, conversationId: conv.id, managers: true }, db);
    await publish({ type: 'conversation.updated', conversationId: conv.id, managers: true }, db);
  });
  return 'stored';
}

/**
 * Coexistência — histórico de conversas do app (até 6 meses), enviado após o onboarding.
 * Não gera alertas, automações nem contadores de não lidas.
 */
export async function handleHistory(account: WaAccount, history: any[]) {
  let stored = 0;
  const businessPhone = (account.display_phone ?? '').replace(/\D/g, '');
  for (const chunk of history ?? []) {
    if (chunk.errors?.length) {
      await logIntegration(`whatsapp:${account.id}`, 'warn', 'history', 'Histórico não compartilhado ou indisponível', chunk.errors);
      continue;
    }
    for (const thread of chunk.threads ?? []) {
      const waId: string = thread.id;
      const leadId = await resolveLead(waId, null, false);
      await withTx(async (db) => {
        const conv = await getOrCreateConversation(db, account.id, waId, { leadId });
        for (const m of thread.messages ?? []) {
          const parsed = parseWaMessage(m);
          const fromBusiness = m.from && (m.from === businessPhone || m.from !== waId);
          const at = new Date(Number(m.timestamp) * 1000 || Date.now());
          const r = await db.query(
            `INSERT INTO messages (conversation_id, direction, wamid, type, body, media_id, media_mime, media_filename, media_status, status, origin, sent_at, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'history',$11,$12)
             ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING`,
            [conv.id, fromBusiness ? 'out' : 'in', m.id, parsed.type, parsed.body, parsed.media_id, parsed.media_mime, parsed.media_filename,
              parsed.media_id ? 'unavailable' : null, fromBusiness ? (m.history_context?.status ?? 'sent').toLowerCase() : 'received', at, JSON.stringify(m)],
          );
          stored += r.rowCount ?? 0;
          if (!fromBusiness) {
            await db.query(`UPDATE conversations SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2) WHERE id=$1`, [conv.id, at]);
          }
          await db.query(
            `UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
               last_message_preview = CASE WHEN last_message_at IS NULL OR $2 >= last_message_at THEN $3 ELSE last_message_preview END WHERE id=$1`,
            [conv.id, at, parsed.preview],
          );
        }
      });
    }
  }
  await logIntegration(`whatsapp:${account.id}`, 'info', 'history', `Histórico sincronizado: ${stored} mensagem(ns) importada(s)`);
  return stored;
}

/** Coexistência — sincronização de contatos do app: atualiza nomes de conversas/leads já existentes */
export async function handleStateSync(account: WaAccount, items: any[]) {
  let updated = 0;
  for (const it of items ?? []) {
    if (it.type !== 'contact' || it.action === 'remove') continue;
    const c = it.contact ?? {};
    const phone = normalizePhone(`+${String(c.phone_number ?? '').replace(/\D/g, '')}`);
    const name = c.full_name || c.first_name;
    if (!phone || !name) continue;
    const r = await pool.query(`UPDATE conversations SET contact_name=$3 WHERE wa_account_id=$1 AND contact_wa_id = ANY($2::text[]) AND contact_name IS NULL`, [
      account.id,
      phoneVariants(phone),
      name,
    ]);
    updated += r.rowCount ?? 0;
  }
  await logIntegration(`whatsapp:${account.id}`, 'info', 'contacts_sync', `Contatos sincronizados do app: ${items?.length ?? 0} recebidos, ${updated} conversa(s) atualizada(s)`);
}

/** Processa um "change" do webhook da conta WhatsApp Business */
export async function processWhatsAppChange(change: any, attempt: number) {
  const value = change.value ?? {};
  const field: string = change.field;
  const phoneNumberId = value.metadata?.phone_number_id;
  if (field === 'message_template_status_update') {
    await pool.query(`UPDATE wa_templates SET status=$2, synced_at=now() WHERE external_id=$1 OR (name=$3 AND language=$4)`, [
      String(value.message_template_id ?? ''),
      value.event,
      value.message_template_name,
      value.message_template_language,
    ]);
    await logIntegration('whatsapp', 'info', 'template_status', `Modelo ${value.message_template_name} (${value.message_template_language}): ${value.event}`, value);
    return;
  }
  if (['account_update', 'phone_number_quality_update', 'account_review_update', 'business_capability_update', 'phone_number_name_update'].includes(field)) {
    if (field === 'phone_number_quality_update' && value.display_phone_number) {
      await pool.query(`UPDATE wa_accounts SET quality_rating=$2 WHERE regexp_replace(COALESCE(display_phone,''), '\\D', '', 'g') = $1`, [
        String(value.display_phone_number).replace(/\D/g, ''),
        value.current_limit ?? value.event,
      ]);
    }
    await logIntegration('whatsapp', 'info', field, `Atualização da conta: ${field}`, value);
    return;
  }
  if (!phoneNumberId) {
    await logIntegration('whatsapp', 'warn', field, `Evento ${field} sem phone_number_id ignorado`, value);
    return;
  }
  const account = await getWaAccountByPhoneNumberId(String(phoneNumberId));
  if (!account) {
    await logIntegration('whatsapp', 'warn', field, `Evento para número não cadastrado (${phoneNumberId}) ignorado`);
    throw new PermanentError(`Número ${phoneNumberId} não cadastrado`);
  }
  switch (field) {
    case 'messages':
      for (const m of value.messages ?? []) await handleInboundMessage(account, m, value.contacts ?? []);
      for (const s of value.statuses ?? []) await handleStatus(account, s, attempt);
      for (const e of value.errors ?? []) await logIntegration(`whatsapp:${account.id}`, 'error', 'webhook_error', e.title ?? e.message ?? 'Erro', e);
      break;
    case 'smb_message_echoes':
      for (const m of value.message_echoes ?? []) await handleEcho(account, m);
      break;
    case 'history':
      await handleHistory(account, value.history ?? []);
      break;
    case 'smb_app_state_sync':
      await handleStateSync(account, value.state_sync ?? []);
      break;
    default:
      await logIntegration(`whatsapp:${account.id}`, 'info', field, `Evento ${field} recebido (sem tratamento específico)`, value);
  }
}
