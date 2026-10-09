import type { AuthUser } from '../lib/auth.js';
import { leadScope } from '../lib/auth.js';
import { Sql } from '../db/pool.js';
import { normalizePhone } from '../lib/phone.js';

export interface LeadFilters {
  q?: string;
  status?: string;
  owner_id?: string;
  course_id?: string;
  source?: string;
  campaign_id?: string;
  tag_id?: string;
  created_from?: string;
  created_to?: string;
  no_contact?: string;
  stale_days?: string;
  reactivation?: string;
  open_opportunity?: string;
  utm_source?: string;
  utm_campaign?: string;
  awaiting_reply?: string;
  ids?: string;
  [k: string]: string | undefined;
}

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** Monta WHERE de leads aplicando filtros combinados e o escopo de permissão do usuário */
export async function buildLeadWhere(user: AuthUser, f: LeadFilters, sql = new Sql()) {
  sql.and('l.deleted_at IS NULL');
  sql.and(await leadScope(user, sql));
  if (f.ids) sql.and(`l.id = ANY(${sql.p(list(f.ids).map(Number))}::bigint[])`);
  if (f.q?.trim()) {
    const q = f.q.trim();
    const digits = q.replace(/\D/g, '');
    const parts = [`l.name ILIKE ${sql.p(`%${q}%`)}`, `l.email ILIKE ${sql.p(`%${q.toLowerCase()}%`)}`];
    if (digits.length >= 4) {
      parts.push(`l.phone LIKE ${sql.p(`%${digits}%`)}`);
      const norm = normalizePhone(q);
      if (norm) parts.push(`l.phone = ${sql.p(norm)}`);
    }
    if (/^\d+$/.test(q) && q.length < 9) parts.push(`l.id = ${sql.p(Number(q))}`);
    sql.and(`(${parts.join(' OR ')})`);
  }
  if (f.status) sql.and(`l.status = ANY(${sql.p(list(f.status))}::text[])`);
  if (f.owner_id) {
    const ids = list(f.owner_id);
    const none = ids.includes('none');
    const nums = ids.filter((x) => x !== 'none').map(Number);
    const parts: string[] = [];
    if (nums.length) parts.push(`l.owner_id = ANY(${sql.p(nums)}::bigint[])`);
    if (none) parts.push('l.owner_id IS NULL');
    if (parts.length) sql.and(`(${parts.join(' OR ')})`);
  }
  if (f.course_id) sql.and(`l.course_id = ANY(${sql.p(list(f.course_id).map(Number))}::bigint[])`);
  if (f.campaign_id) sql.and(`l.campaign_id = ANY(${sql.p(list(f.campaign_id).map(Number))}::bigint[])`);
  if (f.source) sql.and(`l.source = ANY(${sql.p(list(f.source))}::text[])`);
  if (f.utm_source) sql.and(`l.utm_source ILIKE ${sql.p(f.utm_source)}`);
  if (f.utm_campaign) sql.and(`l.utm_campaign ILIKE ${sql.p(`%${f.utm_campaign}%`)}`);
  if (f.tag_id) sql.and(`EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id=l.id AND lt.tag_id = ANY(${sql.p(list(f.tag_id).map(Number))}::bigint[]))`);
  if (f.created_from) sql.and(`l.created_at >= (${sql.p(f.created_from)}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
  if (f.created_to) sql.and(`l.created_at < ((${sql.p(f.created_to)}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`);
  if (f.no_contact === 'true') sql.and(`l.first_contact_at IS NULL AND l.status IN ('new','attempting')`);
  if (f.stale_days) sql.and(`l.status IN ('new','attempting','in_progress','qualified') AND COALESCE(l.last_interaction_at, l.created_at) < now() - make_interval(days => ${sql.p(Number(f.stale_days))}::int)`);
  if (f.reactivation === 'true') sql.and('l.reactivation_flag');
  if (f.open_opportunity === 'true') sql.and(`EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='open')`);
  if (f.open_opportunity === 'false') sql.and(`NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='open')`);
  if (f.awaiting_reply === 'true') sql.and(`EXISTS (SELECT 1 FROM conversations c WHERE c.lead_id=l.id AND c.awaiting_reply AND c.status<>'closed')`);
  // campos personalizados: cf_<chave>=valor
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith('cf_') && v) sql.and(`l.custom->>${sql.p(k.slice(3))} ILIKE ${sql.p(v)}`);
  }
  return sql;
}

export const LEAD_SORTS: Record<string, string> = {
  created_at: 'l.created_at',
  name: 'lower(l.name)',
  last_interaction_at: 'l.last_interaction_at',
  status: 'l.status',
  owner: 'owner_name',
  updated_at: 'l.updated_at',
};
