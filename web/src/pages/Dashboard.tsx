import { useQuery } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { BarList, TimeBars, TimeLines } from '../components/charts';
import { defaultFilters, FilterBar, resolvePeriod } from '../components/FilterBar';
import { ErrorBox, Loading, usePersistentState } from '../components/ui';
import { duration, fmtShort, money, num, pct, relative, TASK_ICONS } from '../format';

function Delta({ v, suffix = '%', invert }: { v: number | null | undefined; suffix?: string; invert?: boolean }) {
  if (v === null || v === undefined) return <span className="muted">sem base anterior</span>;
  if (v === 0) return <span className="muted">igual ao período anterior</span>;
  const up = v > 0;
  const good = invert ? !up : up;
  return <span className={good ? 'delta-up' : 'delta-down'}>{up ? '▲' : '▼'} {Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}{suffix} <span className="muted" style={{ fontWeight: 400 }}>vs. anterior</span></span>;
}

function Kpi({ label, value, foot, to, warn }: { label: string; value: ReactNode; foot?: ReactNode; to?: string; warn?: boolean }) {
  const nav = useNavigate();
  return (
    <div className={`card kpi ${to ? 'link' : ''}`} onClick={() => to && nav(to)} style={warn ? { borderColor: '#fca5a5' } : undefined}>
      <div className="label">{warn && '⚠️'}{label}</div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [filters, setFilters] = usePersistentState('dashboard-filters', defaultFilters);
  const period = resolvePeriod(filters);
  const params = { ...period, owner_id: filters.owner_id, course_id: filters.course_id, campaign_id: filters.campaign_id };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['dashboard', params], queryFn: () => api.get('/api/dashboard', params), refetchInterval: 60_000 });

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Central comercial</h1>
        <span className="sub">Indicadores calculados a partir dos dados registrados no CRM</span>
      </div>
      <FilterBar value={filters} onChange={setFilters} />
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={refetch} />}
      {data && <DashboardBody d={data} />}
    </div>
  );
}

function DashboardBody({ d }: { d: any }) {
  const k = d.kpis;
  const g = d.period.granularity;
  return (
    <>
      <div className="kpis">
        <Kpi label="Leads no período" value={num(k.new_leads)} foot={<Delta v={k.deltas.new_leads} />} to="/leads" />
        <Kpi label="Vendas (matrículas)" value={num(k.sales)} foot={<Delta v={k.deltas.sales} />} />
        <Kpi label="Faturamento" value={money(k.revenue)} foot={<Delta v={k.deltas.revenue} />} />
        <Kpi label="Ticket médio" value={money(k.avg_ticket)} foot={<Delta v={k.deltas.avg_ticket} />} />
        <Kpi label="Conversão de leads" value={pct(k.conversion_rate)} foot={<>{k.converted} de {k.new_leads} leads do período · <Delta v={k.deltas.conversion_rate} suffix=" p.p." /></>} />
        <Kpi label="Negociações em andamento" value={num(k.open_opportunities)} foot={`${money(k.open_value)} em aberto`} to="/funil" />
      </div>
      <div className="kpis">
        <Kpi label="Total de leads" value={num(k.total_leads)} foot={`Hoje ${k.new_today} · semana ${k.new_week} · mês ${k.new_month}`} to="/leads" />
        <Kpi label="Em atendimento" value={num(k.in_service)} to="/leads?status=in_progress,qualified" />
        <Kpi label="Aguardando resposta" value={num(k.awaiting_reply)} warn={k.awaiting_reply > 0} to="/conversas?f=awaiting" />
        <Kpi label="Sem responsável" value={num(k.unassigned)} warn={k.unassigned > 0} to="/leads?owner_id=none" />
        <Kpi label="Sem contato inicial" value={num(k.no_contact)} foot={k.sla_breached ? `${k.sla_breached} fora do SLA de ${d.settings.sla_first_contact_minutes} min` : 'Dentro do SLA'} warn={k.sla_breached > 0} to="/leads?no_contact=true" />
        <Kpi label="Leads parados" value={num(k.stale_leads)} foot={`Sem interação há ${d.settings.stale_lead_days}+ dias`} warn={k.stale_leads > 0} to={`/leads?stale_days=${d.settings.stale_lead_days}`} />
        <Kpi label="Oportunidades paradas" value={num(k.stale_opportunities)} warn={k.stale_opportunities > 0} to="/funil?stale=true" />
        <Kpi label="Para reativação" value={num(k.reactivation)} to="/leads?reactivation=true" />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Leads e vendas por {g === 'day' ? 'dia' : g === 'week' ? 'semana' : 'mês'}</h2></div>
          <div className="card-pad"><TimeLines data={d.series} series={[{ key: 'leads', name: 'Leads' }, { key: 'sales', name: 'Vendas' }]} granularity={g} /></div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Faturamento</h2></div>
          <div className="card-pad"><TimeBars data={d.series} dataKey="revenue" name="Faturamento" granularity={g} format="money" /></div>
        </div>
      </div>

      <div className="grid cols-3">
        <div className="card">
          <div className="card-head"><h2>Origem dos leads</h2></div>
          <div className="card-pad">
            <BarList items={d.sources.map((s: any) => ({ label: s.source, value: s.leads, sub: s.converted ? `${s.converted} conv.` : undefined }))} />
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Atividades pendentes</h2><Link to="/agenda" className="small">Agenda →</Link></div>
          <div className="card-pad">
            <div className="row" style={{ gap: 16, marginBottom: 10 }}>
              <span><b style={{ color: 'var(--danger)' }}>{d.tasks.overdue}</b> vencidas</span>
              <span><b>{d.tasks.today}</b> hoje</span>
              <span><b>{d.tasks.pending}</b> pendentes</span>
            </div>
            {!d.upcoming.length && <div className="muted small">Nada para as próximas 24h.</div>}
            {d.upcoming.map((t: any) => (
              <div key={t.id} className="small" style={{ padding: '4px 0', color: t.overdue ? 'var(--danger)' : undefined }}>
                {TASK_ICONS[t.type]} <b>{fmtShort(t.due_at)}</b> {t.title} {t.lead_id && <Link to={`/leads/${t.lead_id}`}>{t.lead_name}</Link>} <span className="muted">· {t.assignee_name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Alertas</h2></div>
          <div className="card-pad stack" style={{ gap: 10 }}>
            <AlertList title="Sem primeiro contato (SLA)" items={d.alerts.no_contact} render={(a) => <><Link to={`/leads/${a.id}`}>{a.name}</Link> <span className="muted">· entrou {relative(a.created_at)} · {a.owner_name ?? 'sem responsável'}</span></>} />
            <AlertList title="Clientes aguardando resposta" items={d.alerts.awaiting_reply} render={(a) => <><Link to={`/conversas/${a.id}`}>{a.name}</Link> <span className="muted">· {relative(a.awaiting_since)} · {a.assignee_name ?? 'sem responsável'}</span></>} />
            <AlertList title="Leads parados" items={d.alerts.stale_leads} render={(a) => <><Link to={`/leads/${a.id}`}>{a.name}</Link> <span className="muted">· última interação {relative(a.last_at)}</span></>} />
            <AlertList title="Oportunidades esquecidas" items={d.alerts.stale_opportunities} render={(a) => <><Link to={`/funil?opp=${a.id}`}>{a.title}</Link> <span className="muted">· {a.stage_name} desde {relative(a.stage_entered_at)}</span></>} />
            {!d.alerts.no_contact.length && !d.alerts.awaiting_reply.length && !d.alerts.stale_leads.length && !d.alerts.stale_opportunities.length && <div className="muted small">✅ Nenhum alerta no momento.</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Desempenho dos vendedores</h2><span className="small muted">Período selecionado</span></div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Vendedor</th><th className="num">Leads</th><th className="num">Contatados</th><th className="num">Vendas</th><th className="num">Conversão</th>
                <th className="num">Faturamento</th><th className="num">Em negociação</th><th className="num">1º contato (média)</th><th className="num">Tarefas vencidas</th><th className="num">Aguardando</th>
              </tr>
            </thead>
            <tbody>
              {d.sellers.map((s: any) => (
                <tr key={s.id}>
                  <td className="cell-main">{s.name}</td>
                  <td className="num">{s.leads}</td>
                  <td className="num">{s.contacted}</td>
                  <td className="num">{s.sales}</td>
                  <td className="num">{pct(s.conversion_rate)}</td>
                  <td className="num">{money(s.revenue)}</td>
                  <td className="num">{s.open_opportunities}</td>
                  <td className="num">{duration(s.avg_first_contact_seconds)}</td>
                  <td className="num" style={{ color: s.overdue_tasks ? 'var(--danger)' : undefined }}>{s.overdue_tasks}</td>
                  <td className="num" style={{ color: s.awaiting ? 'var(--warning)' : undefined }}>{s.awaiting}</td>
                </tr>
              ))}
              {!d.sellers.length && <tr><td colSpan={10} className="muted">Nenhum vendedor ativo.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function AlertList({ title, items, render }: { title: string; items: any[]; render: (a: any) => ReactNode }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="small" style={{ fontWeight: 650, marginBottom: 4 }}>{title} ({items.length}{items.length === 10 ? '+' : ''})</div>
      {items.map((a) => <div key={a.id} className="small ellipsis" style={{ padding: '2px 0' }}>{render(a)}</div>)}
    </div>
  );
}
