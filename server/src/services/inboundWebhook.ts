import { pool, queryOne } from '../db/pool.js';
import { PermanentError } from '../lib/jobs.js';
import { logIntegration } from './integrationLog.js';
import { intakeLead, IntakeInput } from './leads.js';

/** Lê um caminho "a.b.0.c" de um objeto */
export function getPath(obj: any, path: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);
}

const DEFAULT_MAPPING: Record<string, string[]> = {
  name: ['name', 'nome', 'full_name', 'nome_completo', 'fields.name', 'data.name'],
  phone: ['phone', 'telefone', 'celular', 'whatsapp', 'phone_number', 'fields.phone', 'data.phone'],
  email: ['email', 'e-mail', 'mail', 'fields.email', 'data.email'],
  course: ['course', 'curso', 'produto', 'interesse', 'course_code'],
  city: ['city', 'cidade'],
  state: ['state', 'estado', 'uf'],
  message: ['message', 'mensagem', 'observacao', 'comments'],
  utm_source: ['utm_source'],
  utm_medium: ['utm_medium'],
  utm_campaign: ['utm_campaign'],
  utm_term: ['utm_term'],
  utm_content: ['utm_content'],
  source: ['source', 'origem'],
  campaign: ['campaign', 'campanha'],
  referrer_url: ['page_url', 'url', 'referrer'],
  external_ref: ['id', 'lead_id', 'submission_id'],
};

/** Aplica o mapeamento configurado (campo do CRM -> caminho no payload); usa nomes comuns quando não configurado */
export function mapPayload(payload: any, mapping: Record<string, string> = {}): IntakeInput {
  const out: Record<string, unknown> = {};
  for (const [field, candidates] of Object.entries(DEFAULT_MAPPING)) {
    const configured = mapping[field];
    const paths = configured ? [configured] : candidates;
    for (const p of paths) {
      const v = getPath(payload, p);
      if (v !== undefined && v !== null && v !== '') {
        out[field] = Array.isArray(v) ? v.join(', ') : String(v);
        break;
      }
    }
  }
  const used = new Set(Object.values(mapping));
  const extra: Record<string, unknown> = {};
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (used.has(k) || Object.values(DEFAULT_MAPPING).some((c) => c.includes(k))) continue;
      if (typeof v !== 'object') extra[k] = v;
    }
  }
  return { ...(out as IntakeInput), extra };
}

/** Job: processa um evento de webhook genérico de entrada */
export async function processInboundWebhookJob(p: { eventId: number; integrationId: number }) {
  const ev = await queryOne('SELECT * FROM webhook_events WHERE id=$1', [p.eventId]);
  if (!ev || ev.status === 'processed') return;
  const integ = await queryOne(`SELECT * FROM integrations WHERE id=$1`, [p.integrationId]);
  if (!integ || !integ.active) {
    await pool.query(`UPDATE webhook_events SET status='ignored', error='integração inativa' WHERE id=$1`, [ev.id]);
    return;
  }
  await pool.query(`UPDATE webhook_events SET status='processing', attempts=attempts+1 WHERE id=$1`, [ev.id]);
  try {
    const cfg = integ.config ?? {};
    const input = mapPayload(ev.payload, cfg.mapping ?? {});
    if (!input.source) input.source = cfg.default_source ?? integ.name;
    if (!input.course && !input.course_id && cfg.default_course_id) input.course_id = cfg.default_course_id;
    if (!input.phone && !input.email) throw new PermanentError('Payload sem telefone ou e-mail — verifique o mapeamento de campos');
    const r = await intakeLead(input, `webhook:${integ.id}`);
    await pool.query(`UPDATE webhook_events SET status='processed', processed_at=now(), error=NULL WHERE id=$1`, [ev.id]);
    await pool.query(`UPDATE integrations SET status='connected', last_success_at=now() WHERE id=$1`, [integ.id]);
    await logIntegration(`integration:${integ.id}`, 'info', 'lead', `Lead #${r.leadId} ${r.created ? 'criado' : 'já existia (atualizado)'}`);
  } catch (err) {
    const msg = (err as Error).message;
    const permanent = err instanceof PermanentError || (err as any).statusCode === 400;
    await pool.query(`UPDATE webhook_events SET status=$2, error=$3 WHERE id=$1`, [ev.id, permanent ? 'failed' : 'received', msg]);
    await pool.query(`UPDATE integrations SET last_error_at=now(), last_error=$2 WHERE id=$1`, [integ.id, msg]);
    await logIntegration(`integration:${integ.id}`, 'error', 'lead', `Falha ao processar evento #${ev.id}: ${msg}`);
    if (permanent) throw new PermanentError(msg);
    throw err;
  }
}
