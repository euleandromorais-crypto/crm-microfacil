import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { pool, withTx } from './pool.js';
import { createPipeline, DEFAULT_STAGES } from '../routes/pipelines.js';

const LOST_REASONS = ['Preço / sem condições financeiras', 'Escolheu concorrente', 'Sem interesse no momento', 'Horário/modalidade incompatível', 'Não respondeu / sem contato', 'Dados inválidos', 'Outro'];

/**
 * Configuração inicial mínima (funil padrão, motivos de perda e automações-base).
 * Idempotente: só cria o que ainda não existe. Não cria dados comerciais fictícios.
 */
export async function ensureDefaults() {
  await withTx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(9911001)');
    const p = await db.query('SELECT 1 FROM pipelines LIMIT 1');
    if (!p.rowCount) await createPipeline(db, 'Funil comercial', DEFAULT_STAGES, true);
    const lr = await db.query('SELECT 1 FROM lost_reasons LIMIT 1');
    if (!lr.rowCount) {
      let i = 0;
      for (const name of LOST_REASONS) await db.query('INSERT INTO lost_reasons (name, position) VALUES ($1,$2) ON CONFLICT DO NOTHING', [name, i++]);
    }
    const ar = await db.query('SELECT 1 FROM automation_rules LIMIT 1');
    if (!ar.rowCount) {
      const rules = [
        {
          name: 'Alerta: lead sem primeiro contato',
          description: 'Avisa o responsável e a gestão quando um lead fica 60 minutos sem primeiro contato.',
          trigger: 'lead.no_contact', trigger_config: { minutes: 60 }, conditions: [],
          actions: [
            { type: 'notify', to: 'owner', title: 'Lead aguardando primeiro contato', body: '{{lead.name}} entrou há mais de 1 hora e ainda não foi contatado.' },
            { type: 'notify', to: 'managers', title: 'SLA de primeiro contato estourado', body: '{{lead.name}} — responsável: {{owner.name}}' },
          ],
          active: true,
        },
        {
          name: 'Oportunidade parada → tarefa de acompanhamento',
          description: 'Cria uma tarefa de follow-up quando a oportunidade fica parada além do limite da etapa.',
          trigger: 'opportunity.stale', trigger_config: { days: 5 }, conditions: [],
          actions: [{ type: 'create_task', task_type: 'followup', title: 'Retomar negociação: {{lead.name}}', due_in_minutes: 60, assignee: 'owner' }],
          active: true,
        },
        {
          name: 'Lead sem interação → sinalizar reativação',
          description: 'Marca para reativação leads sem nenhuma interação há 60 dias.',
          trigger: 'lead.no_interaction', trigger_config: { days: 60 }, conditions: [],
          actions: [{ type: 'flag_reactivation' }],
          active: true,
        },
        {
          name: 'Cliente aguardando resposta há 30 min',
          description: 'Notifica o responsável quando o cliente aguarda resposta no WhatsApp há mais de 30 minutos.',
          trigger: 'conversation.awaiting', trigger_config: { minutes: 30 }, conditions: [],
          actions: [{ type: 'notify', to: 'owner', title: 'Cliente aguardando resposta', body: '{{lead.name}} está aguardando resposta no WhatsApp.' }],
          active: true,
        },
        {
          name: 'Atendimento encerrado sem avanço → status "em atendimento"',
          description: 'Exemplo: ao encerrar um atendimento de lead ainda novo, atualiza o status. Ative se fizer sentido para a operação.',
          trigger: 'conversation.closed', trigger_config: {}, conditions: [{ field: 'lead.status', op: 'in', value: 'new,attempting' }],
          actions: [{ type: 'set_lead_status', status: 'in_progress' }],
          active: false,
        },
      ];
      let pos = 1;
      for (const r of rules) {
        await db.query(
          `INSERT INTO automation_rules (name, description, trigger, trigger_config, conditions, actions, active, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [r.name, r.description, r.trigger, JSON.stringify(r.trigger_config), JSON.stringify(r.conditions), JSON.stringify(r.actions), r.active, pos++],
        );
      }
    }
  });
}

export async function hasAdmin() {
  const r = await pool.query(`SELECT 1 FROM users WHERE role='admin' AND active LIMIT 1`);
  return !!r.rowCount;
}

/** Cria o primeiro administrador a partir de ADMIN_EMAIL/ADMIN_PASSWORD quando ainda não existe nenhum */
export async function ensureBootstrapAdmin(log: (m: string) => void = console.log) {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_NAME: name } = config;
  if (!email || !password) return;
  if (await hasAdmin()) return;
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    log('ADMIN_PASSWORD fraca (mínimo 8 caracteres, letras e números): administrador inicial NÃO criado');
    return;
  }
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,$3,'admin',true)
     ON CONFLICT ((lower(email))) DO UPDATE SET role='admin', active=true`,
    [name || 'Administrador', email.trim().toLowerCase(), await bcrypt.hash(password, 12)],
  );
  log(`Administrador inicial criado: ${email}`);
}
