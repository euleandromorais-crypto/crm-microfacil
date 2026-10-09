import { z } from 'zod';
import { Queryable, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notifyUser } from '../lib/notify.js';
import { publish } from '../lib/realtime.js';
import { localDate } from '../lib/time.js';
import { optDate, optId, optNum, optStr } from '../lib/validate.js';
import { emitDomainEvent } from './domainEvents.js';
import { changeLeadStatus } from './leads.js';
import { addLeadEvent } from './timeline.js';

export const opportunityInputSchema = z.object({
  lead_id: z.coerce.number().int().positive(),
  pipeline_id: optId.optional(),
  stage_id: optId.optional(),
  owner_id: optId.optional(),
  course_id: optId.optional(),
  campaign_id: optId.optional(),
  source: optStr(80).optional(),
  title: optStr(200).optional(),
  value: optNum.optional(),
  expected_close_date: optDate.optional(),
});
export type OpportunityInput = z.infer<typeof opportunityInputSchema>;

export async function defaultPipelineId(db: Queryable) {
  const p = await queryOne('SELECT id FROM pipelines WHERE active ORDER BY is_default DESC, position, id LIMIT 1', [], db);
  if (!p) throw badRequest('Nenhum funil ativo configurado');
  return p.id as number;
}

export async function firstOpenStage(db: Queryable, pipelineId: number) {
  const s = await queryOne(`SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND kind='open' AND NOT archived ORDER BY position, id LIMIT 1`, [pipelineId], db);
  if (!s) throw badRequest('O funil não possui etapas abertas');
  return s.id as number;
}

/** Preço vigente de um curso (promocional quando válido) */
export async function coursePrice(db: Queryable, courseId: number | null | undefined) {
  if (!courseId) return null;
  const c = await queryOne('SELECT price, promo_price, promo_until FROM courses WHERE id=$1', [courseId], db);
  if (!c) return null;
  if (c.promo_price !== null && (!c.promo_until || c.promo_until >= localDate())) return Number(c.promo_price);
  return c.price !== null ? Number(c.price) : null;
}

export async function createOpportunity(db: Queryable, input: OpportunityInput, actorId: number | null) {
  const lead = await queryOne('SELECT id, name, owner_id, course_id, campaign_id, source FROM leads WHERE id=$1 AND deleted_at IS NULL', [input.lead_id], db);
  if (!lead) throw notFound('Lead não encontrado');
  const pipelineId = input.pipeline_id ?? (await defaultPipelineId(db));
  let stageId = input.stage_id ?? null;
  if (stageId) {
    const st = await queryOne('SELECT id, kind FROM pipeline_stages WHERE id=$1 AND pipeline_id=$2', [stageId, pipelineId], db);
    if (!st) throw badRequest('Etapa não pertence ao funil');
    if (st.kind !== 'open') throw badRequest('Crie a oportunidade em uma etapa aberta e depois marque como ganha/perdida');
  } else stageId = await firstOpenStage(db, pipelineId);
  const courseId = input.course_id === undefined ? lead.course_id : input.course_id;
  const course = courseId ? await queryOne('SELECT name FROM courses WHERE id=$1', [courseId], db) : null;
  const value = input.value ?? (await coursePrice(db, courseId));
  const title = input.title || (course ? `${course.name} — ${lead.name}` : `Oportunidade — ${lead.name}`);
  const ownerId = input.owner_id === undefined ? lead.owner_id : input.owner_id;
  const opp = (await queryOne(
    `INSERT INTO opportunities (lead_id, pipeline_id, stage_id, owner_id, course_id, campaign_id, source, title, value, expected_close_date, created_by, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, extract(epoch from now()))
     RETURNING *`,
    [lead.id, pipelineId, stageId, ownerId ?? null, courseId ?? null, input.campaign_id ?? lead.campaign_id ?? null, input.source ?? lead.source ?? null,
      title, value, input.expected_close_date ?? null, actorId],
    db,
  ))!;
  await db.query('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, user_id) VALUES ($1,NULL,$2,$3)', [opp.id, stageId, actorId]);
  await addLeadEvent(lead.id, 'opportunity_created', { opportunity_id: opp.id, title, value }, actorId, db);
  await emitDomainEvent({ type: 'opportunity.created', leadId: lead.id, opportunityId: opp.id, userId: actorId }, db);
  await publish({ type: 'opportunity.updated', id: opp.id, leadId: lead.id }, db);
  return opp;
}

export interface MoveOptions {
  sale_value?: number | null;
  lost_reason_id?: number | null;
  lost_note?: string | null;
  position?: number | null;
}

/** Move a oportunidade de etapa, tratando ganho/perda/reabertura e registrando o histórico. */
export async function moveOpportunity(db: Queryable, id: number, stageId: number, actorId: number | null, opts: MoveOptions = {}) {
  const opp = await queryOne('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id], db);
  if (!opp) throw notFound('Oportunidade não encontrada');
  const stage = await queryOne('SELECT * FROM pipeline_stages WHERE id=$1', [stageId], db);
  if (!stage || stage.pipeline_id !== opp.pipeline_id) throw badRequest('Etapa inválida para este funil');

  if (opp.stage_id === stageId) {
    if (opts.position !== undefined && opts.position !== null) {
      await db.query('UPDATE opportunities SET position=$2, updated_at=now() WHERE id=$1', [id, opts.position]);
      await publish({ type: 'opportunity.updated', id, leadId: opp.lead_id }, db);
    }
    return opp;
  }

  const prevStage = await queryOne('SELECT name, kind FROM pipeline_stages WHERE id=$1', [opp.stage_id], db);
  const seconds = Math.max(0, Math.round((Date.now() - new Date(opp.stage_entered_at).getTime()) / 1000));
  let status: 'open' | 'won' | 'lost' = 'open';
  const patch: Record<string, unknown> = {};
  if (stage.kind === 'won') {
    status = 'won';
    const saleValue = opts.sale_value ?? opp.sale_value ?? opp.value;
    if (saleValue === null || saleValue === undefined) throw badRequest('Informe o valor da venda para registrar a matrícula');
    if (Number(saleValue) < 0) throw badRequest('Valor da venda inválido');
    Object.assign(patch, { won_at: new Date(), lost_at: null, lost_reason_id: null, lost_note: null, sale_value: saleValue });
  } else if (stage.kind === 'lost') {
    status = 'lost';
    if (!opts.lost_reason_id) throw badRequest('Informe o motivo da perda');
    Object.assign(patch, { lost_at: new Date(), won_at: null, sale_value: null, lost_reason_id: opts.lost_reason_id, lost_note: opts.lost_note ?? null });
  } else {
    Object.assign(patch, { won_at: null, lost_at: null, lost_reason_id: null, lost_note: null, sale_value: null });
  }
  const cols = Object.keys(patch);
  const updated = (await queryOne(
    `UPDATE opportunities SET stage_id=$2, status=$3, stage_entered_at=now(), position=COALESCE($4, extract(epoch from now())), updated_at=now()
       ${cols.map((c, i) => `, ${c}=$${i + 5}`).join('')}
     WHERE id=$1 RETURNING *`,
    [id, stageId, status, opts.position ?? null, ...Object.values(patch)],
    db,
  ))!;
  await db.query(
    'INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, seconds_in_prev, user_id) VALUES ($1,$2,$3,$4,$5)',
    [id, opp.stage_id, stageId, seconds, actorId],
  );
  await addLeadEvent(opp.lead_id, 'stage_changed', { opportunity_id: id, title: opp.title, from: prevStage?.name, to: stage.name, status }, actorId, db);
  await emitDomainEvent({ type: 'opportunity.stage_changed', leadId: opp.lead_id, opportunityId: id, userId: actorId, data: { from: opp.stage_id, to: stageId } }, db);

  if (status === 'won' && opp.status !== 'won') {
    await changeLeadStatus(db, opp.lead_id, 'customer', actorId, { opportunity_id: id });
    await addLeadEvent(opp.lead_id, 'opportunity_won', { opportunity_id: id, title: opp.title, sale_value: updated.sale_value }, actorId, db);
    await emitDomainEvent({ type: 'opportunity.won', leadId: opp.lead_id, opportunityId: id, userId: actorId, data: { sale_value: updated.sale_value } }, db);
    // gestores acompanham as vendas
    const managers = (await db.query(`SELECT id FROM users WHERE active AND role IN ('admin','manager') AND id <> COALESCE($1, 0)`, [actorId])).rows;
    for (const m of managers) {
      await notifyUser({ userId: m.id, type: 'opportunity.won', title: 'Matrícula realizada', body: `${opp.title} — R$ ${Number(updated.sale_value).toFixed(2).replace('.', ',')}`, link: `/funil?opp=${id}` }, db);
    }
  } else if (status === 'lost' && opp.status !== 'lost') {
    const reason = await queryOne('SELECT name FROM lost_reasons WHERE id=$1', [opts.lost_reason_id], db);
    await addLeadEvent(opp.lead_id, 'opportunity_lost', { opportunity_id: id, title: opp.title, reason: reason?.name, note: opts.lost_note }, actorId, db);
    await emitDomainEvent({ type: 'opportunity.lost', leadId: opp.lead_id, opportunityId: id, userId: actorId }, db);
    // lead perdido quando não restam oportunidades abertas ou ganhas
    const remaining = await queryOne(`SELECT count(*)::int AS n FROM opportunities WHERE lead_id=$1 AND status IN ('open','won')`, [opp.lead_id], db);
    const lead = await queryOne('SELECT status FROM leads WHERE id=$1', [opp.lead_id], db);
    if (remaining!.n === 0 && lead?.status !== 'customer') await changeLeadStatus(db, opp.lead_id, 'lost', actorId, { opportunity_id: id });
  } else if (status === 'open' && opp.status !== 'open') {
    await addLeadEvent(opp.lead_id, 'opportunity_reopened', { opportunity_id: id, title: opp.title }, actorId, db);
    const lead = await queryOne('SELECT status FROM leads WHERE id=$1', [opp.lead_id], db);
    if (lead?.status === 'lost') await changeLeadStatus(db, opp.lead_id, 'in_progress', actorId, { opportunity_id: id });
  } else if (status === 'open') {
    // avanço no funil indica atendimento ativo
    const lead = await queryOne('SELECT status FROM leads WHERE id=$1', [opp.lead_id], db);
    if (lead && ['new', 'attempting'].includes(lead.status) && stage.position > 1) {
      await changeLeadStatus(db, opp.lead_id, 'in_progress', actorId, { auto: true });
    }
  }
  await publish({ type: 'opportunity.updated', id, leadId: opp.lead_id }, db);
  return updated;
}

async function terminalStage(db: Queryable, pipelineId: number, kind: 'won' | 'lost') {
  const s = await queryOne(`SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND kind=$2 AND NOT archived ORDER BY position LIMIT 1`, [pipelineId, kind], db);
  if (!s) throw badRequest(kind === 'won' ? 'O funil não tem etapa de ganho (matrícula)' : 'O funil não tem etapa de perda');
  return s.id as number;
}

export async function winOpportunity(db: Queryable, id: number, saleValue: number | null | undefined, actorId: number | null) {
  const opp = await queryOne('SELECT pipeline_id FROM opportunities WHERE id=$1', [id], db);
  if (!opp) throw notFound('Oportunidade não encontrada');
  return moveOpportunity(db, id, await terminalStage(db, opp.pipeline_id, 'won'), actorId, { sale_value: saleValue });
}

export async function loseOpportunity(db: Queryable, id: number, reasonId: number, note: string | null, actorId: number | null) {
  const opp = await queryOne('SELECT pipeline_id FROM opportunities WHERE id=$1', [id], db);
  if (!opp) throw notFound('Oportunidade não encontrada');
  return moveOpportunity(db, id, await terminalStage(db, opp.pipeline_id, 'lost'), actorId, { lost_reason_id: reasonId, lost_note: note });
}
