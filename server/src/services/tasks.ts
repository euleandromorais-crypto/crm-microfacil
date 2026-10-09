import { z } from 'zod';
import { Queryable, queryOne } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notifyUser } from '../lib/notify.js';
import { publish } from '../lib/realtime.js';
import { optDateTime, optId, optStr } from '../lib/validate.js';
import { emitDomainEvent } from './domainEvents.js';
import { touchLeadInteraction } from './leads.js';
import { addLeadEvent } from './timeline.js';

export const TASK_TYPES = ['call', 'whatsapp', 'meeting', 'visit', 'task', 'followup', 'reminder', 'first_contact'] as const;
/** tarefas que, ao serem concluídas, contam como contato realizado com o lead */
export const CONTACT_TASK_TYPES = ['call', 'whatsapp', 'meeting', 'visit', 'followup', 'first_contact'];

export const taskInputSchema = z.object({
  type: z.enum(TASK_TYPES).default('task'),
  title: z.string().trim().min(1, 'Informe o título').max(300),
  description: optStr(5000).optional(),
  lead_id: optId.optional(),
  opportunity_id: optId.optional(),
  assignee_id: optId.optional(),
  due_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'data/hora inválida'),
  duration_minutes: z.coerce.number().int().min(0).max(24 * 60).default(30),
  remind_minutes_before: z.coerce.number().int().min(0).max(7 * 24 * 60).default(15),
  source: z.string().optional(),
});
export type TaskInput = z.input<typeof taskInputSchema>;

export async function createTask(db: Queryable, raw: TaskInput, actorId: number | null) {
  const input = taskInputSchema.parse(raw);
  let leadId = input.lead_id ?? null;
  if (input.opportunity_id) {
    const opp = await queryOne('SELECT lead_id FROM opportunities WHERE id=$1', [input.opportunity_id], db);
    if (!opp) throw badRequest('Oportunidade não encontrada');
    leadId = leadId ?? opp.lead_id;
  }
  const assignee = input.assignee_id ?? actorId;
  if (assignee) {
    const u = await queryOne('SELECT id FROM users WHERE id=$1 AND active', [assignee], db);
    if (!u) throw badRequest('Responsável inválido ou inativo');
  }
  const task = (await queryOne(
    `INSERT INTO tasks (type, title, description, lead_id, opportunity_id, assignee_id, created_by, due_at, duration_minutes, remind_minutes_before, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.type, input.title, input.description ?? null, leadId, input.opportunity_id ?? null, assignee, actorId, new Date(input.due_at),
      input.duration_minutes, input.remind_minutes_before, input.source ?? 'manual'],
    db,
  ))!;
  if (leadId) await addLeadEvent(leadId, 'task_created', { task_id: task.id, title: task.title, type: task.type, due_at: task.due_at, assignee_id: assignee }, actorId, db);
  if (assignee && assignee !== actorId) {
    await notifyUser({ userId: assignee, type: 'task.assigned', title: 'Nova atividade atribuída a você', body: task.title, link: `/agenda?task=${task.id}` }, db);
  }
  await publish({ type: 'task.updated', id: task.id, users: assignee ? [assignee] : undefined, managers: true }, db);
  return task;
}

export async function completeTask(db: Queryable, id: number, actorId: number | null, outcome?: string | null) {
  const task = await queryOne('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [id], db);
  if (!task) throw notFound('Atividade não encontrada');
  if (task.status === 'done') return task;
  const updated = (await queryOne(
    `UPDATE tasks SET status='done', completed_at=now(), outcome=$2, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, outcome ?? null],
    db,
  ))!;
  if (task.lead_id) {
    await addLeadEvent(task.lead_id, 'task_done', { task_id: id, title: task.title, type: task.type, outcome: outcome ?? null }, actorId, db);
    if (CONTACT_TASK_TYPES.includes(task.type)) await touchLeadInteraction(db, task.lead_id, 'out', new Date(), actorId);
  }
  await emitDomainEvent({ type: 'task.completed', taskId: id, leadId: task.lead_id, opportunityId: task.opportunity_id, userId: actorId }, db);
  await publish({ type: 'task.updated', id, users: task.assignee_id ? [task.assignee_id] : undefined, managers: true }, db);
  return updated;
}
