import { Queryable, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notifyUser } from '../lib/notify.js';
import { publish } from '../lib/realtime.js';
import { getSetting } from '../lib/settings.js';
import { pickOwner } from './distribution.js';
import { emitDomainEvent } from './domainEvents.js';
import { assignLead } from './leads.js';
import { addLeadEvent } from './timeline.js';

/** 24 horas desde a última mensagem do cliente — janela de atendimento do WhatsApp */
export const SERVICE_WINDOW_MS = 24 * 3600 * 1000;

export function windowOpen(lastInboundAt: Date | string | null | undefined, now = Date.now()) {
  if (!lastInboundAt) return false;
  return now - new Date(lastInboundAt).getTime() < SERVICE_WINDOW_MS;
}

export function windowExpiresAt(lastInboundAt: Date | string | null | undefined) {
  if (!lastInboundAt) return null;
  return new Date(new Date(lastInboundAt).getTime() + SERVICE_WINDOW_MS);
}

export async function getOrCreateConversation(
  db: Queryable,
  waAccountId: number,
  contactWaId: string,
  opts: { leadId?: number | null; contactName?: string | null } = {},
) {
  const existing = await queryOne('SELECT * FROM conversations WHERE wa_account_id=$1 AND contact_wa_id=$2', [waAccountId, contactWaId], db);
  if (existing) {
    const patch: string[] = [];
    const params: unknown[] = [existing.id];
    if (opts.contactName && opts.contactName !== existing.contact_name) {
      params.push(opts.contactName);
      patch.push(`contact_name=$${params.length}`);
    }
    if (opts.leadId && !existing.lead_id) {
      params.push(opts.leadId);
      patch.push(`lead_id=$${params.length}`);
    }
    if (patch.length) return (await queryOne(`UPDATE conversations SET ${patch.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, params, db))!;
    return existing;
  }
  const lead = opts.leadId ? await queryOne('SELECT owner_id FROM leads WHERE id=$1', [opts.leadId], db) : null;
  const created = await queryOne(
    `INSERT INTO conversations (wa_account_id, lead_id, contact_wa_id, contact_name, assignee_id, status)
     VALUES ($1,$2,$3,$4,$5,'open')
     ON CONFLICT (wa_account_id, contact_wa_id) DO UPDATE SET updated_at=now()
     RETURNING *`,
    [waAccountId, opts.leadId ?? null, contactWaId, opts.contactName ?? null, lead?.owner_id ?? null],
    db,
  );
  await db.query('INSERT INTO conversation_sessions (conversation_id, assignee_id) VALUES ($1,$2)', [created!.id, created!.assignee_id]);
  return created!;
}

/** Atribui/transfere a conversa. Opcionalmente transfere também a responsabilidade do lead. */
export async function assignConversation(
  db: Queryable,
  conversationId: number,
  assigneeId: number | null,
  actorId: number | null,
  opts: { transferLead?: boolean; note?: string | null } = {},
) {
  const conv = await queryOne('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [conversationId], db);
  if (!conv) throw notFound('Conversa não encontrada');
  if (assigneeId) {
    const u = await queryOne('SELECT id, name FROM users WHERE id=$1 AND active', [assigneeId], db);
    if (!u) throw badRequest('Usuário inválido ou inativo');
  }
  if (conv.assignee_id === assigneeId) return conv;
  await db.query('UPDATE conversations SET assignee_id=$2, updated_at=now() WHERE id=$1', [conversationId, assigneeId]);
  await db.query(
    `UPDATE conversation_sessions SET assignee_id=$2 WHERE id = (SELECT id FROM conversation_sessions WHERE conversation_id=$1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`,
    [conversationId, assigneeId],
  );
  const actor = actorId ? await queryOne('SELECT name FROM users WHERE id=$1', [actorId], db) : null;
  const target = assigneeId ? await queryOne('SELECT name FROM users WHERE id=$1', [assigneeId], db) : null;
  const text = assigneeId
    ? `${conv.assignee_id ? 'Atendimento transferido' : 'Atendimento atribuído'} para ${target!.name}${actor ? ` por ${actor.name}` : ''}${opts.note ? ` — ${opts.note}` : ''}`
    : `Atendimento devolvido para a fila${actor ? ` por ${actor.name}` : ''}`;
  await db.query(`INSERT INTO messages (conversation_id, direction, type, body, status, sender_id, origin) VALUES ($1,'note','system',$2,'note',$3,'crm')`, [
    conversationId,
    text,
    actorId,
  ]);
  if (conv.lead_id) {
    await addLeadEvent(conv.lead_id, 'conversation_assigned', { conversation_id: conversationId, from: conv.assignee_id, to: assigneeId, note: opts.note ?? null }, actorId, db);
    if (opts.transferLead && assigneeId) await assignLead(db, conv.lead_id, assigneeId, actorId, 'conversation_transfer');
  }
  if (assigneeId && assigneeId !== actorId) {
    await notifyUser({ userId: assigneeId, type: 'conversation.assigned', title: 'Conversa atribuída a você', body: conv.contact_name ?? conv.contact_wa_id, link: `/conversas/${conversationId}` }, db);
  }
  await publish({ type: 'conversation.updated', conversationId, users: [assigneeId, conv.assignee_id].filter(Boolean) as number[], managers: true }, db);
  return { ...conv, assignee_id: assigneeId };
}

export async function closeConversation(db: Queryable, conversationId: number, actorId: number | null, reason?: string | null) {
  const conv = await queryOne('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [conversationId], db);
  if (!conv) throw notFound('Conversa não encontrada');
  if (conv.status === 'closed') return conv;
  await db.query(`UPDATE conversations SET status='closed', closed_at=now(), closed_by=$2, awaiting_reply=false, awaiting_since=NULL, unread_count=0, updated_at=now() WHERE id=$1`, [
    conversationId,
    actorId,
  ]);
  await db.query(`UPDATE conversation_sessions SET closed_at=now() WHERE conversation_id=$1 AND closed_at IS NULL`, [conversationId]);
  const actor = actorId ? await queryOne('SELECT name FROM users WHERE id=$1', [actorId], db) : null;
  await db.query(`INSERT INTO messages (conversation_id, direction, type, body, status, sender_id) VALUES ($1,'note','system',$2,'note',$3)`, [
    conversationId,
    `Atendimento encerrado${actor ? ` por ${actor.name}` : ''}${reason ? ` — ${reason}` : ''}`,
    actorId,
  ]);
  if (conv.lead_id) await addLeadEvent(conv.lead_id, 'conversation_closed', { conversation_id: conversationId, reason: reason ?? null }, actorId, db);
  await emitDomainEvent({ type: 'conversation.closed', conversationId, leadId: conv.lead_id, userId: actorId }, db);
  await publish({ type: 'conversation.updated', conversationId, users: conv.assignee_id ? [conv.assignee_id] : undefined, managers: true }, db);
  return conv;
}

export async function reopenConversation(db: Queryable, conversationId: number, actorId: number | null, system = false) {
  const conv = await queryOne('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [conversationId], db);
  if (!conv) throw notFound('Conversa não encontrada');
  if (conv.status !== 'closed') return conv;
  let assignee = conv.assignee_id;
  if (!assignee && conv.lead_id) {
    const lead = await queryOne('SELECT owner_id FROM leads WHERE id=$1', [conv.lead_id], db);
    assignee = lead?.owner_id ?? null;
  }
  await db.query(`UPDATE conversations SET status='open', closed_at=NULL, closed_by=NULL, assignee_id=$2, updated_at=now() WHERE id=$1`, [conversationId, assignee]);
  await db.query('INSERT INTO conversation_sessions (conversation_id, assignee_id) VALUES ($1,$2)', [conversationId, assignee]);
  const actor = actorId ? await queryOne('SELECT name FROM users WHERE id=$1', [actorId], db) : null;
  await db.query(`INSERT INTO messages (conversation_id, direction, type, body, status, sender_id) VALUES ($1,'note','system',$2,'note',$3)`, [
    conversationId,
    system ? 'Atendimento reaberto por nova mensagem do cliente' : `Atendimento reaberto${actor ? ` por ${actor.name}` : ''}`,
    actorId,
  ]);
  await publish({ type: 'conversation.updated', conversationId, users: assignee ? [assignee] : undefined, managers: true }, db);
  return conv;
}

/** Define responsável para conversa nova/sem responsável conforme configurações */
export async function ensureConversationAssignee(db: Queryable, conversationId: number) {
  const conv = await queryOne('SELECT id, assignee_id, lead_id FROM conversations WHERE id=$1', [conversationId], db);
  if (!conv || conv.assignee_id) return conv?.assignee_id ?? null;
  const cfg = await getSetting('whatsapp', db);
  let assignee: number | null = null;
  if (conv.lead_id && cfg.assign_to_lead_owner) {
    const lead = await queryOne('SELECT owner_id FROM leads WHERE id=$1', [conv.lead_id], db);
    assignee = lead?.owner_id ?? null;
  }
  if (!assignee && cfg.distribute_unassigned) {
    assignee = await pickOwner(db);
    if (assignee && conv.lead_id) {
      const lead = await queryOne('SELECT owner_id FROM leads WHERE id=$1', [conv.lead_id], db);
      if (!lead?.owner_id) await assignLead(db, conv.lead_id, assignee, null, 'distribution');
    }
  }
  if (assignee) {
    await db.query('UPDATE conversations SET assignee_id=$2 WHERE id=$1 AND assignee_id IS NULL', [conversationId, assignee]);
    await db.query('UPDATE conversation_sessions SET assignee_id=$2 WHERE conversation_id=$1 AND closed_at IS NULL AND assignee_id IS NULL', [conversationId, assignee]);
  }
  return assignee;
}
