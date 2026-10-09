import type { AuthUser } from '../lib/auth.js';
import { visibleUserIds } from '../lib/auth.js';
import { Sql } from '../db/pool.js';
import { addDays, diffDays, localDate, previousPeriod } from '../lib/time.js';
import { badRequest } from '../lib/errors.js';

export interface ReportFilters {
  from: string;
  to: string;
  prev: { from: string; to: string };
  ownerIds: number[] | null; // null = sem restrição
  includeUnassigned: boolean;
  courseIds: number[];
  campaignIds: number[];
  sources: string[];
  pipelineId: number | null;
  granularity: 'day' | 'week' | 'month';
}

const nums = (v?: string) => (v ? v.split(',').filter(Boolean).map(Number).filter((n) => !Number.isNaN(n)) : []);

export async function parseFilters(u: AuthUser, q: Record<string, string>): Promise<ReportFilters> {
  const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : localDate();
  const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : addDays(to, -29);
  if (from > to) throw badRequest('Período inválido: a data inicial é posterior à final');
  if (diffDays(from, to) > 3 * 366) throw badRequest('Período máximo de 3 anos');
  const visible = await visibleUserIds(u);
  let ownerIds: number[] | null = nums(q.owner_id);
  if (!ownerIds.length) ownerIds = visible;
  else if (visible) ownerIds = ownerIds.filter((id) => visible.includes(id));
  const span = diffDays(from, to);
  const granularity = (q.granularity as any) || (span > 180 ? 'month' : span > 45 ? 'week' : 'day');
  return {
    from,
    to,
    prev: previousPeriod(from, to),
    ownerIds: ownerIds && ownerIds.length ? ownerIds : visible ? [-1] : null,
    includeUnassigned: u.role !== 'seller' && !nums(q.owner_id).length,
    courseIds: nums(q.course_id),
    campaignIds: nums(q.campaign_id),
    sources: q.source ? q.source.split(',') : [],
    pipelineId: q.pipeline_id ? Number(q.pipeline_id) : null,
    granularity,
  };
}

/** intervalo [from, to] em datas locais -> timestamptz */
export function range(sql: Sql, column: string, from: string, to: string) {
  return `${column} >= (${sql.p(from)}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND ${column} < ((${sql.p(to)}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
}

/** Filtros comuns aplicados a leads (alias l) */
export function leadFilterSql(f: ReportFilters, sql: Sql, alias = 'l') {
  const parts = [`${alias}.deleted_at IS NULL`];
  if (f.ownerIds) parts.push(`(${alias}.owner_id = ANY(${sql.p(f.ownerIds)}::bigint[])${f.includeUnassigned ? ` OR ${alias}.owner_id IS NULL` : ''})`);
  if (f.courseIds.length) parts.push(`${alias}.course_id = ANY(${sql.p(f.courseIds)}::bigint[])`);
  if (f.campaignIds.length) parts.push(`${alias}.campaign_id = ANY(${sql.p(f.campaignIds)}::bigint[])`);
  if (f.sources.length) parts.push(`${alias}.source = ANY(${sql.p(f.sources)}::text[])`);
  return parts.join(' AND ');
}

/** Filtros comuns aplicados a oportunidades (alias o, com lead l) */
export function oppFilterSql(f: ReportFilters, sql: Sql, alias = 'o', leadAlias = 'l') {
  const parts = [`${leadAlias}.deleted_at IS NULL`];
  if (f.ownerIds) parts.push(`(${alias}.owner_id = ANY(${sql.p(f.ownerIds)}::bigint[])${f.includeUnassigned ? ` OR ${alias}.owner_id IS NULL` : ''})`);
  if (f.courseIds.length) parts.push(`${alias}.course_id = ANY(${sql.p(f.courseIds)}::bigint[])`);
  if (f.campaignIds.length) parts.push(`COALESCE(${alias}.campaign_id, ${leadAlias}.campaign_id) = ANY(${sql.p(f.campaignIds)}::bigint[])`);
  if (f.sources.length) parts.push(`COALESCE(${alias}.source, ${leadAlias}.source) = ANY(${sql.p(f.sources)}::text[])`);
  if (f.pipelineId) parts.push(`${alias}.pipeline_id = ${sql.p(f.pipelineId)}`);
  return parts.join(' AND ');
}

export const bucket = (g: ReportFilters['granularity'], col: string) =>
  `to_char(date_trunc('${g}', ${col} AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')`;

/** Série temporal completa (preenche períodos sem dados com zero) */
export function fillSeries(f: ReportFilters, rows: { bucket: string; [k: string]: any }[], keys: string[]) {
  const out: any[] = [];
  const map = new Map(rows.map((r) => [r.bucket, r]));
  let cur = startOf(f.from, f.granularity);
  while (cur <= f.to) {
    const r = map.get(cur);
    out.push({ bucket: cur, ...Object.fromEntries(keys.map((k) => [k, r ? Number(r[k] ?? 0) : 0])) });
    cur = next(cur, f.granularity);
  }
  return out;
}

function startOf(d: string, g: string) {
  if (g === 'month') return `${d.slice(0, 7)}-01`;
  if (g === 'week') {
    const dt = new Date(`${d}T12:00:00Z`);
    const dow = (dt.getUTCDay() + 6) % 7; // segunda-feira
    return addDays(d, -dow);
  }
  return d;
}
function next(d: string, g: string) {
  if (g === 'month') {
    const [y, m] = d.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return addDays(d, g === 'week' ? 7 : 1);
}

export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);
export const delta = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : cur > 0 ? null : 0);
