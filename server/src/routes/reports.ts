import type { FastifyInstance } from 'fastify';
import { pool, queryOne, Sql } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { currentUser, requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { STATUS_LABELS } from './leads.js';
import { sendTable } from './export.js';
import { bucket, delta, fillSeries, leadFilterSql, oppFilterSql, parseFilters, pct, range, ReportFilters } from './reportFilters.js';

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

async function captacao(f: ReportFilters) {
  const s = new Sql();
  const where = `${leadFilterSql(f, s)} AND ${range(s, 'l.created_at', f.from, f.to)}`;
  const params = s.params;
  const total = await queryOne(`SELECT count(*)::int AS n FROM leads l WHERE ${where}`, params);
  const sp = new Sql();
  const prev = await queryOne(`SELECT count(*)::int AS n FROM leads l WHERE ${leadFilterSql(f, sp)} AND ${range(sp, 'l.created_at', f.prev.from, f.prev.to)}`, sp.params);
  const series = (await pool.query(`SELECT ${bucket(f.granularity, 'l.created_at')} AS bucket, count(*)::int AS leads FROM leads l WHERE ${where} GROUP BY 1`, params)).rows;
  const group = async (expr: string, label: string, join = '') =>
    (await pool.query(
      `SELECT ${expr} AS ${label}, count(*)::int AS leads,
              count(*) FILTER (WHERE l.first_contact_at IS NOT NULL)::int AS contacted,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted
         FROM leads l ${join} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 100`,
      params,
    )).rows.map((r) => ({ ...r, conversion_rate: pct(r.converted, r.leads) }));
  return {
    total: total!.n,
    previous: prev!.n,
    delta: delta(total!.n, prev!.n),
    series: fillSeries(f, series, ['leads']),
    bySource: await group(`COALESCE(l.source,'Não informada')`, 'source'),
    byCampaign: await group(`COALESCE(cp.name,'Sem campanha')`, 'campaign', 'LEFT JOIN campaigns cp ON cp.id=l.campaign_id'),
    byCourse: await group(`COALESCE(c.name,'Sem curso')`, 'course', 'LEFT JOIN courses c ON c.id=l.course_id'),
    byUtm: await group(`COALESCE(l.utm_source,'(sem utm_source)') || ' / ' || COALESCE(l.utm_medium,'(sem utm_medium)')`, 'utm'),
    byStatus: (await pool.query(`SELECT l.status, count(*)::int AS leads FROM leads l WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows.map((r) => ({ ...r, label: STATUS_LABELS[r.status] })),
  };
}

async function atendimento(f: ReportFilters) {
  // cada consulta usa seu próprio conjunto de parâmetros
  const build = (withRange = true) => {
    const s = new Sql();
    const from = withRange ? s.p(f.from) : '';
    const to = withRange ? s.p(f.to) : '';
    return {
      s,
      from,
      rng: (col: string) => `${col} >= (${from}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND ${col} < ((${to}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`,
      owner: (col: string) => (f.ownerIds ? `AND (${col} = ANY(${s.p(f.ownerIds)}::bigint[])${f.includeUnassigned ? ` OR ${col} IS NULL` : ''})` : ''),
    };
  };
  let { s, from, rng, owner } = build();

  const sessions = await queryOne(
    `SELECT count(*)::int AS conversations,
            count(*) FILTER (WHERE cs.closed_at IS NOT NULL)::int AS closed,
            avg(extract(epoch from (cs.closed_at - cs.opened_at))) FILTER (WHERE cs.closed_at IS NOT NULL) AS avg_duration_seconds
       FROM conversation_sessions cs WHERE ${rng('cs.opened_at')} ${owner('cs.assignee_id')}`,
    s.params,
  );

  ({ s, from, rng, owner } = build());
  // tempo de resposta: para cada mensagem do cliente que inicia uma espera, tempo até a próxima resposta da empresa
  const responseSql = `
    WITH m AS (
      SELECT m.conversation_id, m.direction, m.sent_at, lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at, m.id) AS prev_dir
        FROM messages m WHERE m.direction IN ('in','out') AND m.origin <> 'history' AND m.type <> 'reaction'
         AND m.sent_at >= ((${from}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo') - interval '2 days'),
    starts AS (SELECT conversation_id, sent_at FROM m WHERE direction='in' AND (prev_dir IS NULL OR prev_dir='out') AND ${rng('sent_at')}),
    resp AS (
      SELECT s.conversation_id, s.sent_at,
             (SELECT min(o.sent_at) FROM messages o WHERE o.conversation_id=s.conversation_id AND o.direction='out' AND o.sent_at > s.sent_at) AS replied_at
        FROM starts s)
    SELECT c.assignee_id, GROUPING(c.assignee_id) AS is_total, count(*)::int AS waits, count(r.replied_at)::int AS replied,
           avg(extract(epoch from (r.replied_at - r.sent_at))) AS avg_response_seconds,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (r.replied_at - r.sent_at))) AS median_response_seconds
      FROM resp r JOIN conversations c ON c.id=r.conversation_id WHERE TRUE ${owner('c.assignee_id')}
     GROUP BY ROLLUP(c.assignee_id)`;
  const responses = (await pool.query(responseSql, s.params)).rows;
  const overall = responses.find((r) => r.is_total === 1);

  ({ s, from, rng, owner } = build());
  const firstContact = await queryOne(
    `SELECT avg(extract(epoch from (l.first_contact_at - l.created_at))) AS avg_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from (l.first_contact_at - l.created_at))) AS median_seconds,
            count(*) FILTER (WHERE l.first_contact_at IS NULL)::int AS without_contact,
            count(*)::int AS leads
       FROM leads l WHERE l.deleted_at IS NULL AND ${rng('l.created_at')} ${owner('l.owner_id')}`,
    s.params,
  );

  ({ s, from, rng, owner } = build(false));
  const pending = await queryOne(
    `SELECT (SELECT count(*) FROM conversations c WHERE c.awaiting_reply AND c.status<>'closed' ${owner('c.assignee_id')})::int AS awaiting_conversations,
            (SELECT count(*) FROM conversations c WHERE c.status='pending' ${owner('c.assignee_id')})::int AS pending_conversations,
            (SELECT count(*) FROM leads l WHERE l.deleted_at IS NULL AND l.first_contact_at IS NULL AND l.status IN ('new','attempting') ${owner('l.owner_id')})::int AS leads_without_contact`,
    s.params,
  );

  ({ s, from, rng, owner } = build());
  const sellerCond = f.ownerIds ? `AND u.id = ANY(${s.p(f.ownerIds)}::bigint[])` : '';
  const productivity = (await pool.query(
    `SELECT u.id, u.name,
            (SELECT count(*) FROM conversation_sessions cs WHERE cs.assignee_id=u.id AND ${rng('cs.opened_at')})::int AS conversations,
            (SELECT count(*) FROM messages m WHERE m.sender_id=u.id AND m.direction='out' AND ${rng('m.sent_at')})::int AS messages_sent,
            (SELECT count(*) FROM conversation_sessions cs WHERE cs.assignee_id=u.id AND cs.closed_at IS NOT NULL AND ${rng('cs.closed_at')})::int AS conversations_closed,
            (SELECT count(*) FROM tasks t WHERE t.assignee_id=u.id AND t.status='done' AND ${rng('t.completed_at')})::int AS tasks_done,
            (SELECT count(*) FROM tasks t WHERE t.assignee_id=u.id AND t.status='pending' AND t.due_at < now())::int AS tasks_overdue,
            (SELECT count(*) FROM lead_events e WHERE e.user_id=u.id AND e.type='contact_logged' AND ${rng('e.created_at')})::int AS contacts_logged,
            (SELECT count(*) FROM opportunity_stage_history h WHERE h.user_id=u.id AND h.from_stage_id IS NOT NULL AND ${rng('h.created_at')})::int AS stage_moves,
            (SELECT count(*) FROM conversations c WHERE c.assignee_id=u.id AND c.awaiting_reply AND c.status<>'closed')::int AS awaiting_now
       FROM users u WHERE u.active AND u.role IN ('seller','manager') ${sellerCond} ORDER BY u.name`,
    s.params,
  )).rows;
  const respBySeller = new Map(responses.filter((r) => r.is_total === 0 && r.assignee_id !== null).map((r) => [r.assignee_id, r]));
  return {
    conversations: sessions!.conversations,
    closed: sessions!.closed,
    avg_duration_seconds: sessions!.avg_duration_seconds ? Math.round(num(sessions!.avg_duration_seconds)) : null,
    response: overall
      ? { waits: overall.waits, replied: overall.replied, avg_seconds: overall.avg_response_seconds ? Math.round(num(overall.avg_response_seconds)) : null, median_seconds: overall.median_response_seconds ? Math.round(num(overall.median_response_seconds)) : null }
      : { waits: 0, replied: 0, avg_seconds: null, median_seconds: null },
    first_contact: {
      avg_seconds: firstContact!.avg_seconds ? Math.round(num(firstContact!.avg_seconds)) : null,
      median_seconds: firstContact!.median_seconds ? Math.round(num(firstContact!.median_seconds)) : null,
      without_contact: firstContact!.without_contact,
      leads: firstContact!.leads,
    },
    pending,
    bySeller: productivity.map((p) => {
      const r = respBySeller.get(p.id);
      return { ...p, avg_response_seconds: r?.avg_response_seconds ? Math.round(num(r.avg_response_seconds)) : null, waits: r?.waits ?? 0 };
    }),
  };
}

async function vendas(f: ReportFilters) {
  const s = new Sql();
  const where = `o.status='won' AND ${oppFilterSql(f, s)} AND ${range(s, 'o.won_at', f.from, f.to)}`;
  const p = s.params;
  const totals = await queryOne(
    `SELECT count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue,
            avg(extract(epoch from (o.won_at - o.created_at)))/86400 AS avg_days_to_close,
            avg(extract(epoch from (o.won_at - l.created_at)))/86400 AS avg_days_lead_to_sale
       FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE ${where}`,
    p,
  );
  const sp = new Sql();
  const prev = await queryOne(
    `SELECT count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue FROM opportunities o JOIN leads l ON l.id=o.lead_id
      WHERE o.status='won' AND ${oppFilterSql(f, sp)} AND ${range(sp, 'o.won_at', f.prev.from, f.prev.to)}`,
    sp.params,
  );
  const sl = new Sql();
  const cohort = await queryOne(
    `SELECT count(*)::int AS leads, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted
       FROM leads l WHERE ${leadFilterSql(f, sl)} AND ${range(sl, 'l.created_at', f.from, f.to)}`,
    sl.params,
  );
  const group = async (expr: string, label: string, join = '') =>
    (await pool.query(
      `SELECT ${expr} AS ${label}, count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue, COALESCE(avg(o.sale_value),0) AS avg_ticket
         FROM opportunities o JOIN leads l ON l.id=o.lead_id ${join} WHERE ${where} GROUP BY 1 ORDER BY 3 DESC LIMIT 100`,
      p,
    )).rows.map((r) => ({ ...r, revenue: num(r.revenue), avg_ticket: round2(num(r.avg_ticket)) }));
  const series = (await pool.query(
    `SELECT ${bucket(f.granularity, 'o.won_at')} AS bucket, count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue
       FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE ${where} GROUP BY 1`,
    p,
  )).rows;
  const sx = new Sql();
  const lost = (await pool.query(
    `SELECT COALESCE(lr.name,'Sem motivo') AS reason, count(*)::int AS count, COALESCE(sum(o.value),0) AS value
       FROM opportunities o JOIN leads l ON l.id=o.lead_id LEFT JOIN lost_reasons lr ON lr.id=o.lost_reason_id
      WHERE o.status='lost' AND ${oppFilterSql(f, sx)} AND ${range(sx, 'o.lost_at', f.from, f.to)} GROUP BY 1 ORDER BY 2 DESC`,
    sx.params,
  )).rows.map((r) => ({ ...r, value: num(r.value) }));
  // conversão por vendedor (leads recebidos no período x convertidos)
  const sv = new Sql();
  const bySellerConv = (await pool.query(
    `SELECT l.owner_id, count(*)::int AS leads, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted
       FROM leads l WHERE ${leadFilterSql(f, sv)} AND ${range(sv, 'l.created_at', f.from, f.to)} GROUP BY 1`,
    sv.params,
  )).rows;
  const bySeller = (await group(`COALESCE(u.name,'Sem responsável')`, 'seller', 'LEFT JOIN users u ON u.id=o.owner_id')).map((r) => r);
  const sellerIds = (await pool.query('SELECT id, name FROM users')).rows;
  const sellerConv = bySellerConv.map((r) => ({ seller: sellerIds.find((u) => u.id === r.owner_id)?.name ?? 'Sem responsável', leads: r.leads, converted: r.converted, conversion_rate: pct(r.converted, r.leads) }));
  const revenue = num(totals!.revenue);
  return {
    sales: totals!.sales,
    revenue,
    avg_ticket: totals!.sales ? round2(revenue / totals!.sales) : 0,
    avg_days_to_close: totals!.avg_days_to_close ? round2(num(totals!.avg_days_to_close)) : null,
    avg_days_lead_to_sale: totals!.avg_days_lead_to_sale ? round2(num(totals!.avg_days_lead_to_sale)) : null,
    conversion_rate: pct(cohort!.converted, cohort!.leads),
    cohort,
    previous: { sales: prev!.sales, revenue: num(prev!.revenue) },
    deltas: { sales: delta(totals!.sales, prev!.sales), revenue: delta(revenue, num(prev!.revenue)) },
    series: fillSeries(f, series, ['sales', 'revenue']),
    bySeller,
    sellerConversion: sellerConv,
    byCourse: await group(`COALESCE(c.name,'Sem curso')`, 'course', 'LEFT JOIN courses c ON c.id=o.course_id'),
    bySource: await group(`COALESCE(o.source, l.source, 'Não informada')`, 'source'),
    byCampaign: await group(`COALESCE(cp.name,'Sem campanha')`, 'campaign', 'LEFT JOIN campaigns cp ON cp.id=COALESCE(o.campaign_id, l.campaign_id)'),
    lostReasons: lost,
  };
}

async function funil(f: ReportFilters) {
  const pipelineId = f.pipelineId ?? (await queryOne('SELECT id FROM pipelines WHERE active ORDER BY is_default DESC, position, id LIMIT 1'))?.id;
  if (!pipelineId) return { stages: [] };
  f.pipelineId = pipelineId;
  const stages = (await pool.query('SELECT id, name, kind, position, color FROM pipeline_stages WHERE pipeline_id=$1 AND NOT archived ORDER BY position', [pipelineId])).rows;
  const s = new Sql();
  const where = `${oppFilterSql(f, s)} AND ${range(s, 'o.created_at', f.from, f.to)}`;
  // oportunidades criadas no período que alcançaram cada etapa (em algum momento)
  const reached = (await pool.query(
    `SELECT h.to_stage_id AS stage_id, count(DISTINCT o.id)::int AS reached
       FROM opportunities o JOIN leads l ON l.id=o.lead_id JOIN opportunity_stage_history h ON h.opportunity_id=o.id
      WHERE ${where} GROUP BY 1`,
    s.params,
  )).rows;
  const s2 = new Sql();
  const timeIn = (await pool.query(
    `SELECT h.from_stage_id AS stage_id, avg(h.seconds_in_prev) AS avg_seconds, count(*)::int AS exits
       FROM opportunity_stage_history h JOIN opportunities o ON o.id=h.opportunity_id JOIN leads l ON l.id=o.lead_id
      WHERE h.from_stage_id IS NOT NULL AND ${oppFilterSql(f, s2)} AND ${range(s2, 'h.created_at', f.from, f.to)} GROUP BY 1`,
    s2.params,
  )).rows;
  const s3 = new Sql();
  const current = (await pool.query(
    `SELECT o.stage_id, count(*)::int AS count, COALESCE(sum(COALESCE(o.sale_value, o.value)),0) AS value,
            avg(extract(epoch from (now() - o.stage_entered_at))) FILTER (WHERE o.status='open') AS avg_age_seconds
       FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE ${oppFilterSql(f, s3)} AND (o.status='open' OR ${range(s3, 'COALESCE(o.won_at, o.lost_at)', f.from, f.to)})
      GROUP BY 1`,
    s3.params,
  )).rows;
  const s4 = new Sql();
  const created = await queryOne(`SELECT count(*)::int AS n FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE ${oppFilterSql(f, s4)} AND ${range(s4, 'o.created_at', f.from, f.to)}`, s4.params);
  const base = created!.n;
  const openStages = stages.filter((st) => st.kind === 'open');
  return {
    pipeline_id: pipelineId,
    created: base,
    stages: stages.map((st, i) => {
      const r = reached.find((x) => x.stage_id === st.id)?.reached ?? 0;
      const nextOpen = openStages[openStages.findIndex((x) => x.id === st.id) + 1];
      const nextReached = nextOpen ? reached.find((x) => x.stage_id === nextOpen.id)?.reached ?? 0 : null;
      const t = timeIn.find((x) => x.stage_id === st.id);
      const c = current.find((x) => x.stage_id === st.id);
      return {
        ...st,
        reached: r,
        reached_pct: pct(r, base),
        to_next_pct: nextReached !== null && st.kind === 'open' ? pct(nextReached, r) : null,
        avg_seconds_in_stage: t?.avg_seconds ? Math.round(num(t.avg_seconds)) : null,
        current_count: c?.count ?? 0,
        current_value: num(c?.value),
        avg_age_seconds: c?.avg_age_seconds ? Math.round(num(c.avg_age_seconds)) : null,
        index: i,
      };
    }),
  };
}

async function marketing(f: ReportFilters) {
  const s = new Sql();
  const fromP = s.p(f.from);
  const toP = s.p(f.to);
  const rng = (col: string) => `${col} >= (${fromP}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND ${col} < ((${toP}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  const lf = leadFilterSql(f, s);
  const of = oppFilterSql(f, s);
  const rows = (await pool.query(
    `WITH lead_counts AS (
       SELECT l.campaign_id, count(*)::int AS leads FROM leads l WHERE ${lf} AND ${rng('l.created_at')} GROUP BY 1),
     sale_counts AS (
       SELECT COALESCE(o.campaign_id, l.campaign_id) AS campaign_id, count(*)::int AS sales, sum(o.sale_value) AS revenue
         FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE o.status='won' AND ${of} AND ${rng('o.won_at')} GROUP BY 1),
     spend AS (
       SELECT campaign_id, sum(amount) AS spend, sum(clicks) AS clicks, sum(impressions) AS impressions FROM campaign_spend
        WHERE day BETWEEN ${fromP}::date AND ${toP}::date GROUP BY 1)
     SELECT c.id, c.name, c.channel, c.utm_campaign, COALESCE(lc.leads,0) AS leads, COALESCE(sc.sales,0) AS sales, COALESCE(sc.revenue,0) AS revenue,
            sp.spend, sp.clicks, sp.impressions
       FROM campaigns c LEFT JOIN lead_counts lc ON lc.campaign_id=c.id LEFT JOIN sale_counts sc ON sc.campaign_id=c.id LEFT JOIN spend sp ON sp.campaign_id=c.id
      WHERE COALESCE(lc.leads,0) > 0 OR COALESCE(sc.sales,0) > 0 OR sp.spend IS NOT NULL
     UNION ALL
     SELECT NULL, 'Sem campanha', NULL, NULL, COALESCE((SELECT leads FROM lead_counts WHERE campaign_id IS NULL),0),
            COALESCE((SELECT sales FROM sale_counts WHERE campaign_id IS NULL),0), COALESCE((SELECT revenue FROM sale_counts WHERE campaign_id IS NULL),0), NULL, NULL, NULL
     ORDER BY 5 DESC`,
    s.params,
  )).rows;
  const campaigns = rows
    .filter((r) => r.id !== null || r.leads > 0 || r.sales > 0)
    .map((r) => {
      const spend = r.spend === null ? null : num(r.spend);
      const revenue = num(r.revenue);
      const hasSpend = spend !== null && spend > 0;
      return {
        ...r,
        revenue,
        spend,
        conversion_rate: pct(r.sales, r.leads),
        // métricas de custo só existem quando há investimento registrado
        cpl: hasSpend && r.leads > 0 ? round2(spend! / r.leads) : null,
        cpa: hasSpend && r.sales > 0 ? round2(spend! / r.sales) : null,
        roas: hasSpend ? round2(revenue / spend!) : null,
      };
    });
  const su = new Sql();
  const utm = (await pool.query(
    `SELECT COALESCE(l.utm_source,'—') AS utm_source, COALESCE(l.utm_medium,'—') AS utm_medium, COALESCE(l.utm_campaign,'—') AS utm_campaign,
            count(*)::int AS leads,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted,
            COALESCE((SELECT sum(o.sale_value) FROM opportunities o WHERE o.lead_id = ANY(array_agg(l.id)) AND o.status='won'),0) AS revenue
       FROM leads l WHERE ${leadFilterSql(f, su)} AND ${range(su, 'l.created_at', f.from, f.to)} AND (l.utm_source IS NOT NULL OR l.utm_campaign IS NOT NULL)
      GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 200`,
    su.params,
  )).rows.map((r) => ({ ...r, revenue: num(r.revenue), conversion_rate: pct(r.converted, r.leads) }));
  const withSpend = campaigns.filter((c) => c.spend && c.spend > 0);
  const totalSpend = withSpend.reduce((a, c) => a + (c.spend ?? 0), 0);
  const spendLeads = withSpend.reduce((a, c) => a + c.leads, 0);
  const spendSales = withSpend.reduce((a, c) => a + c.sales, 0);
  const spendRevenue = withSpend.reduce((a, c) => a + c.revenue, 0);
  return {
    campaigns,
    utm,
    totals: {
      campaigns_with_leads: campaigns.filter((c) => c.id && c.leads > 0).length,
      campaigns_with_sales: campaigns.filter((c) => c.id && c.sales > 0).length,
      spend: withSpend.length ? round2(totalSpend) : null,
      cpl: totalSpend > 0 && spendLeads ? round2(totalSpend / spendLeads) : null,
      cpa: totalSpend > 0 && spendSales ? round2(totalSpend / spendSales) : null,
      roas: totalSpend > 0 ? round2(spendRevenue / totalSpend) : null,
      has_spend_data: withSpend.length > 0,
    },
  };
}

const REPORTS: Record<string, (f: ReportFilters) => Promise<any>> = { captacao, atendimento, vendas, funil, marketing };

/** Converte um relatório em tabelas exportáveis */
function toTables(type: string, data: any): { name: string; header: string[]; rows: unknown[][] } {
  const fmtSec = (s: number | null) => (s === null || s === undefined ? '' : (s / 60).toFixed(1).replace('.', ','));
  switch (type) {
    case 'captacao':
      return {
        name: 'captacao',
        header: ['Dimensão', 'Valor', 'Leads', 'Contatados', 'Convertidos', 'Conversão (%)'],
        rows: [
          ...data.bySource.map((r: any) => ['Origem', r.source, r.leads, r.contacted, r.converted, r.conversion_rate]),
          ...data.byCampaign.map((r: any) => ['Campanha', r.campaign, r.leads, r.contacted, r.converted, r.conversion_rate]),
          ...data.byCourse.map((r: any) => ['Curso', r.course, r.leads, r.contacted, r.converted, r.conversion_rate]),
          ...data.byUtm.map((r: any) => ['UTM source/medium', r.utm, r.leads, r.contacted, r.converted, r.conversion_rate]),
          ...data.series.map((r: any) => ['Período', r.bucket, r.leads, '', '', '']),
        ],
      };
    case 'atendimento':
      return {
        name: 'atendimento',
        header: ['Vendedor', 'Conversas', 'Mensagens enviadas', 'Atendimentos encerrados', 'Tempo médio de resposta (min)', 'Tarefas concluídas', 'Tarefas vencidas', 'Contatos registrados', 'Movimentações no funil', 'Aguardando agora'],
        rows: data.bySeller.map((r: any) => [r.name, r.conversations, r.messages_sent, r.conversations_closed, fmtSec(r.avg_response_seconds), r.tasks_done, r.tasks_overdue, r.contacts_logged, r.stage_moves, r.awaiting_now]),
      };
    case 'vendas':
      return {
        name: 'vendas',
        header: ['Dimensão', 'Valor', 'Vendas', 'Faturamento', 'Ticket médio'],
        rows: [
          ...data.bySeller.map((r: any) => ['Vendedor', r.seller, r.sales, r.revenue, r.avg_ticket]),
          ...data.byCourse.map((r: any) => ['Curso', r.course, r.sales, r.revenue, r.avg_ticket]),
          ...data.bySource.map((r: any) => ['Origem', r.source, r.sales, r.revenue, r.avg_ticket]),
          ...data.byCampaign.map((r: any) => ['Campanha', r.campaign, r.sales, r.revenue, r.avg_ticket]),
          ...data.lostReasons.map((r: any) => ['Motivo de perda', r.reason, r.count, r.value, '']),
        ],
      };
    case 'funil':
      return {
        name: 'funil',
        header: ['Etapa', 'Tipo', 'Alcançaram', '% do total', 'Conversão p/ próxima (%)', 'Tempo médio na etapa (h)', 'Atual (qtd)', 'Atual (valor)'],
        rows: data.stages.map((s: any) => [s.name, s.kind, s.reached, s.reached_pct, s.to_next_pct ?? '', s.avg_seconds_in_stage ? (s.avg_seconds_in_stage / 3600).toFixed(1).replace('.', ',') : '', s.current_count, s.current_value]),
      };
    case 'marketing':
      return {
        name: 'marketing',
        header: ['Campanha', 'Canal', 'utm_campaign', 'Leads', 'Vendas', 'Conversão (%)', 'Faturamento', 'Investimento', 'CPL', 'CPA', 'ROAS'],
        rows: data.campaigns.map((c: any) => [c.name, c.channel ?? '', c.utm_campaign ?? '', c.leads, c.sales, c.conversion_rate ?? '', c.revenue, c.spend ?? '', c.cpl ?? '', c.cpa ?? '', c.roas ?? '']),
      };
  }
  throw notFound();
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports/:type', async (req) => {
    const u = currentUser(req);
    const type = (req.params as any).type as string;
    const fn = REPORTS[type];
    if (!fn) throw notFound('Relatório inexistente');
    const f = await parseFilters(u, req.query as Record<string, string>);
    return { period: { from: f.from, to: f.to, prev: f.prev, granularity: f.granularity }, data: await fn(f) };
  });

  app.get('/api/reports/:type/export', async (req, reply) => {
    const u = requireRole(req, 'admin', 'manager');
    const type = (req.params as any).type as string;
    const fn = REPORTS[type];
    if (!fn) throw notFound('Relatório inexistente');
    const q = req.query as Record<string, string>;
    const f = await parseFilters(u, q);
    const t = toTables(type, await fn(f));
    await audit({ userId: u.id, action: 'report.export', entityType: 'report', changes: { type, from: f.from, to: f.to }, ip: req.ip });
    return sendTable(reply, q.format === 'xlsx' ? 'xlsx' : 'csv', `relatorio-${t.name}-${f.from}-a-${f.to}`, t.header, t.rows);
  });
}
