import type { FastifyInstance } from 'fastify';
import { pool, queryOne, Sql } from '../db/pool.js';
import { currentUser } from '../lib/auth.js';
import { getSetting } from '../lib/settings.js';
import { bucket, delta, fillSeries, leadFilterSql, oppFilterSql, parseFilters, pct, range, ReportFilters } from './reportFilters.js';

async function periodKpis(f: ReportFilters, from: string, to: string) {
  const s1 = new Sql();
  const leads = await queryOne(
    `SELECT count(*)::int AS new_leads,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted
       FROM leads l WHERE ${leadFilterSql(f, s1)} AND ${range(s1, 'l.created_at', from, to)}`,
    s1.params,
  );
  const s2 = new Sql();
  const sales = await queryOne(
    `SELECT count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue
       FROM opportunities o JOIN leads l ON l.id=o.lead_id
      WHERE o.status='won' AND ${oppFilterSql(f, s2)} AND ${range(s2, 'o.won_at', from, to)}`,
    s2.params,
  );
  const revenue = Number(sales!.revenue);
  return {
    new_leads: leads!.new_leads,
    converted: leads!.converted,
    conversion_rate: pct(leads!.converted, leads!.new_leads),
    sales: sales!.sales,
    revenue,
    avg_ticket: sales!.sales ? Math.round((revenue / sales!.sales) * 100) / 100 : 0,
  };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    const u = currentUser(req);
    const f = await parseFilters(u, req.query as Record<string, string>);
    const general = await getSetting('general');

    const [cur, prev] = await Promise.all([periodKpis(f, f.from, f.to), periodKpis(f, f.prev.from, f.prev.to)]);

    // instantâneo (estado atual, independe do período)
    const s = new Sql();
    const lf = leadFilterSql(f, s);
    const staleDays = s.p(general.stale_lead_days);
    const sla = s.p(general.sla_first_contact_minutes);
    const snapshot = await queryOne(
      `SELECT count(*)::int AS total_leads,
              count(*) FILTER (WHERE (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS new_today,
              count(*) FILTER (WHERE l.created_at >= date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')::int AS new_week,
              count(*) FILTER (WHERE l.created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')::int AS new_month,
              count(*) FILTER (WHERE l.status IN ('in_progress','qualified'))::int AS in_service,
              count(*) FILTER (WHERE l.owner_id IS NULL AND l.status IN ('new','attempting','in_progress','qualified'))::int AS unassigned,
              count(*) FILTER (WHERE l.first_contact_at IS NULL AND l.status IN ('new','attempting'))::int AS no_contact,
              count(*) FILTER (WHERE l.first_contact_at IS NULL AND l.status IN ('new','attempting') AND l.created_at < now() - make_interval(mins => ${sla}::int))::int AS sla_breached,
              count(*) FILTER (WHERE l.status IN ('new','attempting','in_progress','qualified') AND COALESCE(l.last_interaction_at, l.created_at) < now() - make_interval(days => ${staleDays}::int))::int AS stale_leads,
              count(*) FILTER (WHERE l.reactivation_flag)::int AS reactivation,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.lead_id=l.id AND c.awaiting_reply AND c.status<>'closed'))::int AS awaiting_reply
         FROM leads l WHERE ${lf}`,
      s.params,
    );

    const so = new Sql();
    const opps = await queryOne(
      `SELECT count(*)::int AS open, COALESCE(sum(o.value),0) AS open_value,
              count(*) FILTER (WHERE o.stage_entered_at < now() - make_interval(days => COALESCE(st.stale_after_days, ${so.p(general.opportunity_stale_days)}::int)))::int AS stale
         FROM opportunities o JOIN leads l ON l.id=o.lead_id JOIN pipeline_stages st ON st.id=o.stage_id
        WHERE o.status='open' AND ${oppFilterSql(f, so)}`,
      so.params,
    );

    // séries
    const ss = new Sql();
    const leadSeries = (await pool.query(
      `SELECT ${bucket(f.granularity, 'l.created_at')} AS bucket, count(*)::int AS leads FROM leads l
        WHERE ${leadFilterSql(f, ss)} AND ${range(ss, 'l.created_at', f.from, f.to)} GROUP BY 1`,
      ss.params,
    )).rows;
    const sw = new Sql();
    const salesSeries = (await pool.query(
      `SELECT ${bucket(f.granularity, 'o.won_at')} AS bucket, count(*)::int AS sales, COALESCE(sum(o.sale_value),0) AS revenue
         FROM opportunities o JOIN leads l ON l.id=o.lead_id WHERE o.status='won' AND ${oppFilterSql(f, sw)} AND ${range(sw, 'o.won_at', f.from, f.to)} GROUP BY 1`,
      sw.params,
    )).rows;
    const series = fillSeries(f, [...leadSeries, ...salesSeries].reduce((acc: any[], r) => {
      const e = acc.find((x) => x.bucket === r.bucket);
      if (e) Object.assign(e, r);
      else acc.push({ ...r });
      return acc;
    }, []), ['leads', 'sales', 'revenue']);

    // origens
    const sor = new Sql();
    const sources = (await pool.query(
      `SELECT COALESCE(l.source, 'Não informada') AS source, count(*)::int AS leads,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opportunities o WHERE o.lead_id=l.id AND o.status='won'))::int AS converted
         FROM leads l WHERE ${leadFilterSql(f, sor)} AND ${range(sor, 'l.created_at', f.from, f.to)} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      sor.params,
    )).rows;

    // desempenho dos vendedores
    const sv = new Sql();
    const from = sv.p(f.from);
    const to = sv.p(f.to);
    const rng = (col: string) => `${col} >= (${from}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo' AND ${col} < ((${to}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
    const ownerCond = f.ownerIds ? `u.id = ANY(${sv.p(f.ownerIds)}::bigint[])` : 'TRUE';
    const sellers = (await pool.query(
      `SELECT u.id, u.name,
              (SELECT count(*) FROM leads l WHERE l.owner_id=u.id AND l.deleted_at IS NULL AND ${rng('l.created_at')})::int AS leads,
              (SELECT count(*) FROM leads l WHERE l.owner_id=u.id AND l.deleted_at IS NULL AND ${rng('l.created_at')} AND l.first_contact_at IS NOT NULL)::int AS contacted,
              (SELECT count(*) FROM opportunities o WHERE o.owner_id=u.id AND o.status='won' AND ${rng('o.won_at')})::int AS sales,
              (SELECT COALESCE(sum(o.sale_value),0) FROM opportunities o WHERE o.owner_id=u.id AND o.status='won' AND ${rng('o.won_at')}) AS revenue,
              (SELECT count(*) FROM opportunities o WHERE o.owner_id=u.id AND o.status='open')::int AS open_opportunities,
              (SELECT count(*) FROM tasks t WHERE t.assignee_id=u.id AND t.status='pending' AND t.due_at < now())::int AS overdue_tasks,
              (SELECT count(*) FROM tasks t WHERE t.assignee_id=u.id AND t.status='done' AND ${rng('t.completed_at')})::int AS done_tasks,
              (SELECT count(*) FROM conversations c WHERE c.assignee_id=u.id AND c.awaiting_reply AND c.status<>'closed')::int AS awaiting,
              (SELECT avg(extract(epoch from (l.first_contact_at - l.created_at))) FROM leads l WHERE l.owner_id=u.id AND l.first_contact_at IS NOT NULL AND ${rng('l.created_at')}) AS avg_first_contact_seconds
         FROM users u WHERE u.active AND u.role IN ('seller','manager') AND ${ownerCond}
        ORDER BY revenue DESC, sales DESC, u.name`,
      sv.params,
    )).rows.map((r) => ({ ...r, revenue: Number(r.revenue), conversion_rate: pct(r.sales, r.leads), avg_first_contact_seconds: r.avg_first_contact_seconds ? Math.round(Number(r.avg_first_contact_seconds)) : null }));

    // alertas (listas curtas)
    const sa = new Sql();
    const lfa = leadFilterSql(f, sa);
    const slaA = sa.p(general.sla_first_contact_minutes);
    const alertsNoContact = (await pool.query(
      `SELECT l.id, l.name, l.created_at, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
        WHERE ${lfa} AND l.first_contact_at IS NULL AND l.status IN ('new','attempting') AND l.created_at < now() - make_interval(mins => ${slaA}::int)
        ORDER BY l.created_at LIMIT 10`,
      sa.params,
    )).rows;
    const sb = new Sql();
    const lfb = leadFilterSql(f, sb);
    const alertsStale = (await pool.query(
      `SELECT l.id, l.name, COALESCE(l.last_interaction_at, l.created_at) AS last_at, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
        WHERE ${lfb} AND l.status IN ('new','attempting','in_progress','qualified') AND COALESCE(l.last_interaction_at, l.created_at) < now() - make_interval(days => ${sb.p(general.stale_lead_days)}::int)
        ORDER BY COALESCE(l.last_interaction_at, l.created_at) LIMIT 10`,
      sb.params,
    )).rows;
    const sc = new Sql();
    const alertsOpps = (await pool.query(
      `SELECT o.id, o.title, o.stage_entered_at, st.name AS stage_name, o.value, u.name AS owner_name FROM opportunities o
         JOIN leads l ON l.id=o.lead_id JOIN pipeline_stages st ON st.id=o.stage_id LEFT JOIN users u ON u.id=o.owner_id
        WHERE o.status='open' AND ${oppFilterSql(f, sc)} AND o.stage_entered_at < now() - make_interval(days => COALESCE(st.stale_after_days, ${sc.p(general.opportunity_stale_days)}::int))
        ORDER BY o.stage_entered_at LIMIT 10`,
      sc.params,
    )).rows;
    const sd = new Sql();
    const convOwner = f.ownerIds ? `AND (c.assignee_id = ANY(${sd.p(f.ownerIds)}::bigint[])${f.includeUnassigned ? ' OR c.assignee_id IS NULL' : ''})` : '';
    const alertsAwaiting = (await pool.query(
      `SELECT c.id, COALESCE(l.name, c.contact_name, c.contact_wa_id) AS name, c.awaiting_since, u.name AS assignee_name FROM conversations c
         LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN users u ON u.id=c.assignee_id
        WHERE c.awaiting_reply AND c.status<>'closed' AND c.awaiting_since < now() - interval '30 minutes' ${convOwner}
        ORDER BY c.awaiting_since LIMIT 10`,
      sd.params,
    )).rows;

    // atividades pendentes
    const st = new Sql();
    const taskOwner = f.ownerIds ? `AND t.assignee_id = ANY(${st.p(f.ownerIds)}::bigint[])` : '';
    const tasks = await queryOne(
      `SELECT count(*) FILTER (WHERE t.due_at < now())::int AS overdue,
              count(*) FILTER (WHERE (t.due_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today,
              count(*)::int AS pending
         FROM tasks t WHERE t.status='pending' ${taskOwner}`,
      st.params,
    );
    const st2 = new Sql();
    const taskOwner2 = f.ownerIds ? `AND t.assignee_id = ANY(${st2.p(f.ownerIds)}::bigint[])` : '';
    const upcoming = (await pool.query(
      `SELECT t.id, t.title, t.type, t.due_at, t.lead_id, l.name AS lead_name, u.name AS assignee_name, (t.due_at < now()) AS overdue
         FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id LEFT JOIN users u ON u.id=t.assignee_id
        WHERE t.status='pending' ${taskOwner2} AND t.due_at < now() + interval '1 day' ORDER BY t.due_at LIMIT 12`,
      st2.params,
    )).rows;

    return {
      period: { from: f.from, to: f.to, prev: f.prev, granularity: f.granularity },
      kpis: {
        ...snapshot,
        open_opportunities: opps!.open,
        open_value: Number(opps!.open_value),
        stale_opportunities: opps!.stale,
        ...cur,
        previous: prev,
        deltas: {
          new_leads: delta(cur.new_leads, prev.new_leads),
          sales: delta(cur.sales, prev.sales),
          revenue: delta(cur.revenue, prev.revenue),
          avg_ticket: delta(cur.avg_ticket, prev.avg_ticket),
          conversion_rate: cur.conversion_rate !== null && prev.conversion_rate !== null ? Math.round((cur.conversion_rate - prev.conversion_rate) * 100) / 100 : null,
        },
      },
      series,
      sources,
      sellers,
      tasks,
      upcoming,
      alerts: { no_contact: alertsNoContact, stale_leads: alertsStale, stale_opportunities: alertsOpps, awaiting_reply: alertsAwaiting },
      settings: { sla_first_contact_minutes: general.sla_first_contact_minutes, stale_lead_days: general.stale_lead_days },
    };
  });
}
