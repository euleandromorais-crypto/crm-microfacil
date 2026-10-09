import { pool, queryOne } from '../../db/pool.js';
import { decryptJson } from '../../lib/crypto.js';
import { PermanentError } from '../../lib/jobs.js';
import { logIntegration } from '../integrationLog.js';
import { intakeLead, IntakeInput } from '../leads.js';
import { graph } from './graph.js';

export interface LeadAdsConfig {
  /** páginas do Facebook atendidas por esta integração */
  page_ids?: string[];
  /** formulário -> curso (id) */
  form_courses?: Record<string, number>;
  default_course_id?: number | null;
}

export async function getLeadAdsIntegration(pageId?: string) {
  const rows = (await pool.query(`SELECT * FROM integrations WHERE type='meta_lead_ads' AND active ORDER BY id`)).rows;
  const row = pageId ? rows.find((r) => !r.config?.page_ids?.length || r.config.page_ids.includes(String(pageId))) : rows[0];
  if (!row) return null;
  return { ...row, secrets: decryptJson<{ page_access_token?: string }>(row.secrets_enc) };
}

const FIELD_ALIASES: Record<string, keyof IntakeInput> = {
  full_name: 'name', nome: 'name', nome_completo: 'name', name: 'name', first_name: 'name',
  email: 'email', 'e-mail': 'email',
  phone_number: 'phone', telefone: 'phone', celular: 'phone', whatsapp: 'phone', phone: 'phone',
  city: 'city', cidade: 'city', state: 'state', estado: 'state',
  curso: 'course', course: 'course',
};

/** Converte os campos do formulário do Lead Ads em dados do lead */
export function mapLeadgenFields(fieldData: { name: string; values: string[] }[]) {
  const out: IntakeInput = {};
  const extra: Record<string, unknown> = {};
  let lastName = '';
  for (const f of fieldData ?? []) {
    const key = f.name.toLowerCase();
    const value = (f.values ?? []).join(', ');
    if (key === 'last_name') {
      lastName = value;
      continue;
    }
    const target = FIELD_ALIASES[key];
    if (target && !(out as any)[target]) (out as any)[target] = value;
    else extra[f.name] = value;
  }
  if (lastName) out.name = `${out.name ?? ''} ${lastName}`.trim();
  out.extra = extra;
  return out;
}

async function campaignByExternal(externalId: string | undefined, name: string | undefined) {
  if (!externalId) return null;
  const r = await queryOne(
    `INSERT INTO campaigns (name, channel, external_id) VALUES ($1,'meta_ads',$2)
     ON CONFLICT (channel, external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = COALESCE(campaigns.name, EXCLUDED.name)
     RETURNING id`,
    [name || `Campanha Meta ${externalId}`, externalId],
  );
  return r!.id as number;
}

/** Job: busca o lead na Graph API e registra no CRM */
export async function fetchAndIntakeLeadgen(p: { leadgen_id: string; page_id?: string; form_id?: string; created_time?: number }) {
  const exists = await queryOne(`SELECT 1 FROM lead_events WHERE type IN ('created','reentry','intake_data') AND data->>'leadgen_id' = $1 LIMIT 1`, [p.leadgen_id]);
  if (exists) return;
  const integ = await getLeadAdsIntegration(p.page_id);
  if (!integ?.secrets.page_access_token) {
    await logIntegration('meta_lead_ads', 'error', 'leadgen', `Lead ${p.leadgen_id} recebido, mas não há integração Lead Ads ativa com token para a página ${p.page_id}`);
    throw new PermanentError('Integração Lead Ads não configurada');
  }
  const lead = await graph<any>(p.leadgen_id, {
    token: integ.secrets.page_access_token,
    query: { fields: 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic' },
  });
  const mapped = mapLeadgenFields(lead.field_data ?? []);
  const cfg: LeadAdsConfig = integ.config ?? {};
  const formId = lead.form_id ?? p.form_id;
  const courseId = (formId && cfg.form_courses?.[formId]) || cfg.default_course_id || null;
  const campaignId = await campaignByExternal(lead.campaign_id, lead.campaign_name);
  const platform = String(lead.platform ?? '').toLowerCase();
  const result = await intakeLead(
    {
      ...mapped,
      course_id: mapped.course ? undefined : courseId,
      source: 'Meta Lead Ads',
      campaign_id: campaignId,
      utm_source: platform === 'ig' || platform === 'instagram' ? 'instagram' : 'facebook',
      utm_medium: lead.is_organic ? 'organic' : 'paid',
      utm_campaign: lead.campaign_name ?? null,
      utm_content: lead.ad_name ?? null,
      utm_term: lead.adset_name ?? null,
      external_ref: lead.id,
      consent_whatsapp: false,
      extra: { ...mapped.extra, leadgen_id: lead.id, form_id: formId, ad_id: lead.ad_id, adset_id: lead.adset_id },
    },
    'meta_lead_ads',
  );
  // marca o leadgen_id na linha do tempo para idempotência
  await pool.query(
    `INSERT INTO lead_events (lead_id, type, data) VALUES ($1,'intake_data',$2)`,
    [result.leadId, JSON.stringify({ via: 'meta_lead_ads', leadgen_id: lead.id, form_id: formId, campaign: lead.campaign_name, ad: lead.ad_name })],
  );
  await pool.query(`UPDATE integrations SET status='connected', last_success_at=now() WHERE id=$1`, [integ.id]);
  await logIntegration(`integration:${integ.id}`, 'info', 'leadgen', `Lead ${lead.id} ${result.created ? 'criado' : 'atualizado (já existia)'} — #${result.leadId}`);
}

/** Recuperação: busca leads de um formulário num intervalo (ex.: quando o webhook ficou indisponível) */
export async function backfillForm(integrationId: number, formId: string, sinceDays: number) {
  const row = await queryOne(`SELECT * FROM integrations WHERE id=$1 AND type='meta_lead_ads'`, [integrationId]);
  if (!row) throw new Error('Integração não encontrada');
  const secrets = decryptJson<{ page_access_token?: string }>(row.secrets_enc);
  if (!secrets.page_access_token) throw new Error('Token da página não configurado');
  const since = Math.floor((Date.now() - sinceDays * 86400_000) / 1000);
  let url: string | null = `${formId}/leads`;
  let first = true;
  let queued = 0;
  const { enqueue } = await import('../../lib/jobs.js');
  while (url) {
    const page: any = await graph(url, first
      ? { token: secrets.page_access_token, query: { fields: 'id,created_time', limit: 100, filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]) } }
      : { token: secrets.page_access_token });
    first = false;
    for (const l of page.data ?? []) {
      await enqueue('meta.leadgen', { leadgen_id: l.id, form_id: formId }, { dedupeKey: `leadgen-${l.id}` });
      queued++;
    }
    url = page.paging?.next ?? null;
  }
  await logIntegration(`integration:${integrationId}`, 'info', 'backfill', `${queued} lead(s) do formulário ${formId} enfileirados para importação`);
  return queued;
}
