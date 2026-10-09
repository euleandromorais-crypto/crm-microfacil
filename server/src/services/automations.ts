import { z } from 'zod';
import { pool, queryOne, withTx } from '../db/pool.js';
import { enqueue } from '../lib/jobs.js';
import { notifyManagers, notifyUser } from '../lib/notify.js';
import { pickOwner } from './distribution.js';
import type { DomainEvent } from './domainEvents.js';
import { assignLead, changeLeadStatus, LEAD_STATUSES } from './leads.js';
import { createOpportunity, moveOpportunity } from './opportunities.js';
import { createTask, TASK_TYPES } from './tasks.js';
import { addLeadEvent } from './timeline.js';

// ---------------------------------------------------------------------------
// Catálogo de gatilhos, condições e ações (exposto para a interface)
// ---------------------------------------------------------------------------

export const EVENT_TRIGGERS = {
  'lead.created': 'Novo lead recebido',
  'lead.status_changed': 'Status do lead alterado',
  'lead.owner_changed': 'Responsável do lead alterado',
  'opportunity.created': 'Oportunidade criada',
  'opportunity.stage_changed': 'Oportunidade mudou de etapa',
  'opportunity.won': 'Matrícula realizada (oportunidade ganha)',
  'opportunity.lost': 'Oportunidade perdida',
  'conversation.closed': 'Atendimento encerrado',
  'message.received': 'Mensagem recebida no WhatsApp',
  'task.completed': 'Atividade concluída',
} as const;

export const SCHEDULE_TRIGGERS = {
  'lead.no_contact': 'Lead sem primeiro contato após X minutos',
  'lead.no_interaction': 'Lead sem interação há X dias',
  'opportunity.stale': 'Oportunidade parada na etapa há X dias',
  'conversation.awaiting': 'Cliente aguardando resposta há X minutos',
  'task.overdue': 'Atividade vencida há X minutos',
} as const;

export const TRIGGERS = { ...EVENT_TRIGGERS, ...SCHEDULE_TRIGGERS };
export type TriggerKey = keyof typeof TRIGGERS;

export const CONDITION_FIELDS: Record<string, string> = {
  'lead.status': 'Status do lead',
  'lead.source': 'Origem do lead',
  'lead.course_id': 'Curso de interesse',
  'lead.campaign_id': 'Campanha',
  'lead.owner_id': 'Responsável',
  'lead.utm_source': 'utm_source',
  'lead.utm_campaign': 'utm_campaign',
  'lead.tags': 'Etiquetas do lead',
  'lead.consent_whatsapp': 'Consentimento WhatsApp',
  'opportunity.pipeline_id': 'Funil',
  'opportunity.stage_id': 'Etapa da oportunidade',
  'opportunity.course_id': 'Curso da oportunidade',
  'opportunity.value': 'Valor previsto',
  'event.from': 'Valor anterior (mudança)',
  'event.to': 'Novo valor (mudança)',
};

const conditionSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'in', 'not_in', 'empty', 'not_empty', 'gt', 'lt', 'contains', 'not_contains']),
  value: z.any().optional(),
});

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assign_owner'), mode: z.enum(['distribution', 'user']), user_id: z.number().int().optional().nullable() }),
  z.object({
    type: z.literal('create_task'),
    task_type: z.enum(TASK_TYPES).default('followup'),
    title: z.string().min(1),
    description: z.string().optional().nullable(),
    due_in_minutes: z.number().int().min(0).default(60),
    assignee: z.enum(['owner', 'user']).default('owner'),
    user_id: z.number().int().optional().nullable(),
  }),
  z.object({ type: z.literal('notify'), to: z.enum(['owner', 'managers', 'user']), user_id: z.number().int().optional().nullable(), title: z.string().min(1), body: z.string().optional().nullable() }),
  z.object({ type: z.literal('set_lead_status'), status: z.enum(LEAD_STATUSES) }),
  z.object({ type: z.literal('add_tag'), tag_id: z.number().int() }),
  z.object({ type: z.literal('remove_tag'), tag_id: z.number().int() }),
  z.object({ type: z.literal('move_opportunity'), stage_id: z.number().int() }),
  z.object({ type: z.literal('create_opportunity'), pipeline_id: z.number().int().optional().nullable() }),
  z.object({ type: z.literal('flag_reactivation') }),
  z.object({
    type: z.literal('send_whatsapp_template'),
    template_name: z.string().min(1),
    language: z.string().min(2),
    params: z.array(z.string()).default([]),
  }),
]);

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  trigger: z.string().refine((t) => t in TRIGGERS, 'gatilho inválido'),
  trigger_config: z.object({ minutes: z.number().int().min(1).optional(), days: z.number().int().min(1).optional(), statuses: z.array(z.string()).optional() }).default({}),
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1, 'Adicione ao menos uma ação'),
  delay_minutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  active: z.boolean().default(true),
});
export type RuleInput = z.infer<typeof ruleSchema>;
type Action = z.infer<typeof actionSchema>;
type Condition = z.infer<typeof conditionSchema>;

// ---------------------------------------------------------------------------
// Contexto e avaliação
// ---------------------------------------------------------------------------

interface Ctx {
  lead: any | null;
  opportunity: any | null;
  conversation: any | null;
  task: any | null;
  event: Record<string, any>;
  owner: any | null;
  course: any | null;
}

async function loadContext(refs: { leadId?: number | null; opportunityId?: number | null; conversationId?: number | null; taskId?: number | null; data?: any }): Promise<Ctx> {
  const opportunity = refs.opportunityId ? await queryOne('SELECT * FROM opportunities WHERE id=$1', [refs.opportunityId]) : null;
  const conversation = refs.conversationId ? await queryOne('SELECT * FROM conversations WHERE id=$1', [refs.conversationId]) : null;
  const task = refs.taskId ? await queryOne('SELECT * FROM tasks WHERE id=$1', [refs.taskId]) : null;
  const leadId = refs.leadId ?? opportunity?.lead_id ?? conversation?.lead_id ?? task?.lead_id ?? null;
  const lead = leadId ? await queryOne('SELECT l.*, ARRAY(SELECT tag_id FROM lead_tags WHERE lead_id=l.id) AS tags FROM leads l WHERE l.id=$1 AND l.deleted_at IS NULL', [leadId]) : null;
  const owner = lead?.owner_id ? await queryOne('SELECT id, name, email, team_id FROM users WHERE id=$1', [lead.owner_id]) : null;
  const courseId = opportunity?.course_id ?? lead?.course_id;
  const course = courseId ? await queryOne('SELECT id, name FROM courses WHERE id=$1', [courseId]) : null;
  return { lead, opportunity, conversation, task, event: refs.data ?? {}, owner, course };
}

function getField(ctx: Ctx, field: string) {
  const [root, key] = field.split('.');
  const obj = (ctx as any)[root];
  return obj ? obj[key] : undefined;
}

export function evalCondition(ctx: Ctx, c: Condition): boolean {
  const v = getField(ctx, c.field);
  const target = c.value;
  const asList = (x: unknown) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : String(x).split(',')).map((s) => String(s).trim());
  switch (c.op) {
    case 'eq':
      return String(v ?? '') === String(target ?? '');
    case 'neq':
      return String(v ?? '') !== String(target ?? '');
    case 'in':
      return asList(target).includes(String(v ?? ''));
    case 'not_in':
      return !asList(target).includes(String(v ?? ''));
    case 'empty':
      return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    case 'not_empty':
      return !(v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length));
    case 'gt':
      return Number(v) > Number(target);
    case 'lt':
      return Number(v) < Number(target);
    case 'contains':
      return Array.isArray(v) ? v.map(String).includes(String(target)) : String(v ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'not_contains':
      return Array.isArray(v) ? !v.map(String).includes(String(target)) : !String(v ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
  }
}

/** Substitui {{lead.name}}, {{course.name}}, {{owner.name}}, {{opportunity.title}} */
export function renderText(tpl: string, ctx: Ctx) {
  return tpl.replace(/\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/gi, (_m, root, key) => {
    const obj = (ctx as any)[root];
    const v = obj?.[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

async function executeAction(a: Action, ctx: Ctx, rule: any, depth: number): Promise<string> {
  const lead = ctx.lead;
  const needLead = () => {
    if (!lead) throw new Error('Ação requer um lead vinculado');
    return lead;
  };
  switch (a.type) {
    case 'assign_owner': {
      const l = needLead();
      return withTx(async (db) => {
        const target = a.mode === 'user' ? a.user_id ?? null : await pickOwner(db);
        if (!target) return 'nenhum vendedor disponível para distribuição';
        await assignLead(db, l.id, target, null, `automation:${rule.id}`);
        return `responsável definido: #${target}`;
      });
    }
    case 'create_task': {
      const l = needLead();
      const assignee = a.assignee === 'user' ? a.user_id : l.owner_id;
      if (!assignee) return 'tarefa não criada: lead sem responsável';
      const t = await withTx((db) =>
        createTask(db, {
          type: a.task_type,
          title: renderText(a.title, ctx),
          description: a.description ? renderText(a.description, ctx) : null,
          lead_id: l.id,
          opportunity_id: ctx.opportunity?.id ?? null,
          assignee_id: assignee,
          due_at: new Date(Date.now() + a.due_in_minutes * 60_000).toISOString(),
          source: 'automation',
        }, null),
      );
      return `tarefa #${t.id} criada`;
    }
    case 'notify': {
      const title = renderText(a.title, ctx);
      const body = a.body ? renderText(a.body, ctx) : lead?.name ?? null;
      const link = lead ? `/leads/${lead.id}` : ctx.conversation ? `/conversas/${ctx.conversation.id}` : ctx.task ? `/agenda?task=${ctx.task.id}` : null;
      if (a.to === 'managers') await notifyManagers({ type: 'automation', title, body, link }, ctx.owner?.team_id ?? null);
      else {
        const uid = a.to === 'owner' ? lead?.owner_id ?? ctx.task?.assignee_id ?? ctx.conversation?.assignee_id : a.user_id;
        if (!uid) return 'notificação não enviada: sem destinatário';
        await notifyUser({ userId: uid, type: 'automation', title, body, link });
      }
      return 'notificação enviada';
    }
    case 'set_lead_status': {
      const l = needLead();
      await withTx((db) => changeLeadStatus(db, l.id, a.status, null, { automation: rule.id }));
      return `status: ${a.status}`;
    }
    case 'add_tag':
      await pool.query('INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [needLead().id, a.tag_id]);
      return `etiqueta #${a.tag_id} adicionada`;
    case 'remove_tag':
      await pool.query('DELETE FROM lead_tags WHERE lead_id=$1 AND tag_id=$2', [needLead().id, a.tag_id]);
      return `etiqueta #${a.tag_id} removida`;
    case 'move_opportunity': {
      if (!ctx.opportunity) throw new Error('Ação requer uma oportunidade');
      await withTx((db) => moveOpportunity(db, ctx.opportunity.id, a.stage_id, null));
      return `oportunidade movida para etapa #${a.stage_id}`;
    }
    case 'create_opportunity': {
      const l = needLead();
      const open = await queryOne(`SELECT id FROM opportunities WHERE lead_id=$1 AND status='open' LIMIT 1`, [l.id]);
      if (open) return `já existe oportunidade aberta (#${open.id})`;
      const o = await withTx((db) => createOpportunity(db, { lead_id: l.id, pipeline_id: a.pipeline_id ?? undefined }, null));
      return `oportunidade #${o.id} criada`;
    }
    case 'flag_reactivation': {
      const l = needLead();
      await pool.query('UPDATE leads SET reactivation_flag=true, updated_at=now() WHERE id=$1', [l.id]);
      await addLeadEvent(l.id, 'reactivation_flag', { rule_id: rule.id });
      return 'lead sinalizado para reativação';
    }
    case 'send_whatsapp_template': {
      const l = needLead();
      // políticas da Meta: só envia para quem consentiu, um envio por lead por regra, sem disparo em massa
      if (!l.consent_whatsapp) return 'não enviado: lead sem consentimento para WhatsApp';
      if (!l.phone) return 'não enviado: lead sem telefone';
      const { defaultWaAccount } = await import('./meta/app.js');
      const { getOrCreateConversation } = await import('./conversations.js');
      const { sendMessage } = await import('./whatsapp/outbound.js');
      const account = await defaultWaAccount();
      if (!account || account.status !== 'connected') throw new Error('Nenhuma conta de WhatsApp conectada');
      const conv = await withTx((db) => getOrCreateConversation(db, account.id, l.phone, { leadId: l.id, contactName: l.name }));
      const params = a.params.map((p) => ({ type: 'text', text: renderText(p, ctx) || '-' }));
      await sendMessage(conv.id, { kind: 'template', name: a.template_name, language: a.language, components: params.length ? [{ type: 'body', parameters: params }] : [] }, null, 'automation');
      return `modelo ${a.template_name} enviado`;
    }
  }
}

export async function runRule(rule: any, refs: { leadId?: number | null; opportunityId?: number | null; conversationId?: number | null; taskId?: number | null; data?: any }, dedupeKey: string | null, depth = 0) {
  const ctx = await loadContext(refs);
  const entityType = refs.opportunityId ? 'opportunity' : refs.conversationId ? 'conversation' : refs.taskId ? 'task' : 'lead';
  const entityId = (refs.opportunityId ?? refs.conversationId ?? refs.taskId ?? refs.leadId ?? 0) as number;
  // lead excluído/mesclado depois do evento: nada a fazer
  if (refs.leadId && !ctx.lead && !refs.opportunityId && !refs.conversationId && !refs.taskId) return 'skipped';
  const conditions: Condition[] = rule.conditions ?? [];
  if (!conditions.every((c) => evalCondition(ctx, c))) return 'skipped';

  const results: { action: string; ok: boolean; result?: string; error?: string }[] = [];
  for (const action of rule.actions as Action[]) {
    try {
      results.push({ action: action.type, ok: true, result: await executeAction(action, ctx, rule, depth) });
      // recarrega o contexto: ações anteriores podem ter alterado o lead (ex.: responsável)
      Object.assign(ctx, await loadContext(refs));
    } catch (err) {
      results.push({ action: action.type, ok: false, error: (err as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const status = failed === 0 ? 'success' : failed === results.length ? 'failed' : 'partial';
  const ins = await pool.query(
    `INSERT INTO automation_runs (rule_id, entity_type, entity_id, dedupe_key, status, result, error) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (rule_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [rule.id, entityType, entityId, dedupeKey, status, JSON.stringify(results), failed ? results.filter((r) => !r.ok).map((r) => `${r.action}: ${r.error}`).join('; ') : null],
  );
  if (ins.rowCount) {
    await pool.query(
      `UPDATE automation_rules SET run_count=run_count+1, fail_count=fail_count+$2, last_run_at=now() WHERE id=$1`,
      [rule.id, status === 'success' ? 0 : 1],
    );
  }
  if (status !== 'success' && ins.rowCount) {
    await notifyManagers({ type: 'automation.failed', title: `Falha na automação "${rule.name}"`, body: results.filter((r) => !r.ok).map((r) => r.error).join('; '), link: '/automacoes' });
  }
  return status;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Job domain.event: distribui um evento de negócio para automações e webhooks de saída */
export async function handleDomainEvent(event: DomainEvent & { at?: string }) {
  const { dispatchOutbound } = await import('./outboundWebhooks.js');
  await dispatchOutbound(event);
  const depth = event.depth ?? 0;
  if (depth >= 3) return;
  const rules = (await pool.query('SELECT id, delay_minutes FROM automation_rules WHERE active AND trigger=$1 ORDER BY position, id', [event.type])).rows;
  for (const r of rules) {
    await enqueue('automation.run', { ruleId: r.id, event }, { delayMs: r.delay_minutes * 60_000, maxAttempts: 3 });
  }
}

export async function handleAutomationRun(p: { ruleId: number; event: DomainEvent }) {
  const rule = await queryOne('SELECT * FROM automation_rules WHERE id=$1 AND active', [p.ruleId]);
  if (!rule) return;
  await runRule(rule, { leadId: p.event.leadId, opportunityId: p.event.opportunityId, conversationId: p.event.conversationId, taskId: p.event.taskId, data: p.event.data }, null, (p.event.depth ?? 0) + 1);
}

/** Avalia regras baseadas em tempo (executado periodicamente pelo agendador) */
export async function runScheduledRules(limitPerRule = 200) {
  const rules = (await pool.query(`SELECT * FROM automation_rules WHERE active AND trigger = ANY($1::text[]) ORDER BY position, id`, [Object.keys(SCHEDULE_TRIGGERS)])).rows;
  let total = 0;
  for (const rule of rules) {
    const cfg = rule.trigger_config ?? {};
    let rows: { lead_id?: number; opportunity_id?: number; conversation_id?: number; task_id?: number; key: string }[] = [];
    switch (rule.trigger) {
      case 'lead.no_contact':
        rows = (await pool.query(
          `SELECT l.id AS lead_id, 'lead:' || l.id AS key FROM leads l
            WHERE l.deleted_at IS NULL AND l.first_contact_at IS NULL AND l.status IN ('new','attempting')
              AND l.created_at < now() - make_interval(mins => $1::int) AND l.created_at > now() - interval '30 days'
              AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.rule_id=$2 AND r.dedupe_key = 'lead:' || l.id)
            ORDER BY l.created_at LIMIT $3`,
          [cfg.minutes ?? 60, rule.id, limitPerRule],
        )).rows;
        break;
      case 'lead.no_interaction': {
        const statuses = cfg.statuses?.length ? cfg.statuses : ['new', 'attempting', 'in_progress', 'qualified', 'lost', 'unqualified'];
        rows = (await pool.query(
          `SELECT l.id AS lead_id, 'lead:' || l.id || ':' || extract(epoch from COALESCE(l.last_interaction_at, l.created_at))::bigint AS key FROM leads l
            WHERE l.deleted_at IS NULL AND l.status = ANY($4::text[])
              AND COALESCE(l.last_interaction_at, l.created_at) < now() - make_interval(days => $1::int)
              AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.rule_id=$2 AND r.dedupe_key = 'lead:' || l.id || ':' || extract(epoch from COALESCE(l.last_interaction_at, l.created_at))::bigint)
            ORDER BY COALESCE(l.last_interaction_at, l.created_at) LIMIT $3`,
          [cfg.days ?? 60, rule.id, limitPerRule, statuses],
        )).rows;
        break;
      }
      case 'opportunity.stale':
        rows = (await pool.query(
          `SELECT o.id AS opportunity_id, o.lead_id, 'opp:' || o.id || ':' || extract(epoch from o.stage_entered_at)::bigint AS key
             FROM opportunities o JOIN pipeline_stages s ON s.id=o.stage_id
            WHERE o.status='open' AND o.stage_entered_at < now() - make_interval(days => COALESCE(s.stale_after_days, $1::int))
              AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.rule_id=$2 AND r.dedupe_key = 'opp:' || o.id || ':' || extract(epoch from o.stage_entered_at)::bigint)
            ORDER BY o.stage_entered_at LIMIT $3`,
          [cfg.days ?? 7, rule.id, limitPerRule],
        )).rows;
        break;
      case 'conversation.awaiting':
        rows = (await pool.query(
          `SELECT c.id AS conversation_id, c.lead_id, 'conv:' || c.id || ':' || extract(epoch from c.awaiting_since)::bigint AS key FROM conversations c
            WHERE c.awaiting_reply AND c.status <> 'closed' AND c.awaiting_since < now() - make_interval(mins => $1::int)
              AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.rule_id=$2 AND r.dedupe_key = 'conv:' || c.id || ':' || extract(epoch from c.awaiting_since)::bigint)
            LIMIT $3`,
          [cfg.minutes ?? 30, rule.id, limitPerRule],
        )).rows;
        break;
      case 'task.overdue':
        rows = (await pool.query(
          `SELECT t.id AS task_id, t.lead_id, 'task:' || t.id || ':' || extract(epoch from t.due_at)::bigint AS key FROM tasks t
            WHERE t.status='pending' AND t.due_at < now() - make_interval(mins => $1::int)
              AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.rule_id=$2 AND r.dedupe_key = 'task:' || t.id || ':' || extract(epoch from t.due_at)::bigint)
            LIMIT $3`,
          [cfg.minutes ?? 60, rule.id, limitPerRule],
        )).rows;
        break;
    }
    for (const r of rows) {
      const status = await runRule(rule, { leadId: r.lead_id, opportunityId: r.opportunity_id, conversationId: r.conversation_id, taskId: r.task_id }, r.key);
      if (status === 'skipped') {
        // registra para não reavaliar o mesmo episódio a cada ciclo
        await pool.query(
          `INSERT INTO automation_runs (rule_id, entity_type, entity_id, dedupe_key, status) VALUES ($1,'scheduled',$2,$3,'skipped') ON CONFLICT DO NOTHING`,
          [rule.id, r.lead_id ?? r.opportunity_id ?? r.conversation_id ?? r.task_id ?? 0, r.key],
        );
      }
      total++;
    }
  }
  return total;
}
