import { useQuery } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { download } from '../api';
import { api } from '../api';
import { useAuth } from '../auth';
import { BarList, TimeBars, TimeLines } from '../components/charts';
import { defaultFilters, FilterBar, resolvePeriod } from '../components/FilterBar';
import { ErrorBox, Field, Loading, Tabs, usePersistentState, useToast } from '../components/ui';
import { duration, money, num, pct } from '../format';
import { usePipelines } from '../hooks';

type Tab = 'captacao' | 'atendimento' | 'vendas' | 'funil' | 'marketing';

const Stat = ({ label, value, foot }: { label: string; value: ReactNode; foot?: ReactNode }) => (
  <div className="card kpi"><div className="label">{label}</div><div className="value">{value}</div>{foot && <div className="foot">{foot}</div>}</div>
);

function Table({ head, rows, empty = 'Sem dados no período' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 ? 'num' : ''}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? 'num' : ''}>{c}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={head.length} className="muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const Card = ({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) => (
  <div className="card"><div className="card-head"><h2>{title}</h2>{extra}</div><div className="card-pad">{children}</div></div>
);

export default function Reports() {
  const { isManager } = useAuth();
  const toast = useToast();
  const [tab, setTab] = usePersistentState<{ t: Tab }>('reports-tab', { t: 'captacao' });
  const [filters, setFilters] = usePersistentState('reports-filters', defaultFilters);
  const [pipelineId, setPipelineId] = useState('');
  const { data: pipelines } = usePipelines();
  const period = resolvePeriod(filters);
  const params = { ...period, owner_id: filters.owner_id, course_id: filters.course_id, campaign_id: filters.campaign_id, pipeline_id: tab.t === 'funil' ? pipelineId : undefined };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['report', tab.t, params], queryFn: () => api.get(`/api/reports/${tab.t}`, params) });
  const exp = (format: 'csv' | 'xlsx') => download(`/api/reports/${tab.t}/export`, { ...params, format }).catch((e) => toast(e.message, 'error'));
  const d = data?.data;
  const g = data?.period?.granularity;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Relatórios e indicadores</h1>
        <span className="grow" />
        {isManager && <button className="btn" onClick={() => exp('xlsx')}>Exportar Excel</button>}
        {isManager && <button className="btn" onClick={() => exp('csv')}>CSV</button>}
      </div>
      <Tabs value={tab.t} onChange={(t) => setTab({ t })} items={[{ value: 'captacao', label: 'Captação' }, { value: 'atendimento', label: 'Atendimento' }, { value: 'vendas', label: 'Vendas' }, { value: 'funil', label: 'Funil' }, { value: 'marketing', label: 'Marketing' }]} />
      <FilterBar value={filters} onChange={setFilters} extra={tab.t === 'funil' && (
        <Field label="Funil"><select className="select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}><option value="">Padrão</option>{pipelines?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      )} />
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={refetch} />}
      {d && tab.t === 'captacao' && (
        <>
          <div className="kpis">
            <Stat label="Leads no período" value={num(d.total)} foot={`Período anterior: ${num(d.previous)}${d.delta !== null ? ` (${d.delta > 0 ? '+' : ''}${d.delta}%)` : ''}`} />
            {d.byStatus.slice(0, 4).map((s: any) => <Stat key={s.status} label={s.label} value={num(s.leads)} />)}
          </div>
          <Card title="Evolução da captação"><TimeBars data={d.series} dataKey="leads" name="Leads" granularity={g} /></Card>
          <div className="grid cols-2">
            <Card title="Por origem"><Table head={['Origem', 'Leads', 'Contatados', 'Convertidos', 'Conversão']} rows={d.bySource.map((r: any) => [r.source, num(r.leads), num(r.contacted), num(r.converted), pct(r.conversion_rate)])} /></Card>
            <Card title="Por campanha"><Table head={['Campanha', 'Leads', 'Contatados', 'Convertidos', 'Conversão']} rows={d.byCampaign.map((r: any) => [r.campaign, num(r.leads), num(r.contacted), num(r.converted), pct(r.conversion_rate)])} /></Card>
            <Card title="Por curso"><Table head={['Curso', 'Leads', 'Contatados', 'Convertidos', 'Conversão']} rows={d.byCourse.map((r: any) => [r.course, num(r.leads), num(r.contacted), num(r.converted), pct(r.conversion_rate)])} /></Card>
            <Card title="Por UTM (source / medium)"><Table head={['UTM', 'Leads', 'Contatados', 'Convertidos', 'Conversão']} rows={d.byUtm.map((r: any) => [r.utm, num(r.leads), num(r.contacted), num(r.converted), pct(r.conversion_rate)])} /></Card>
          </div>
        </>
      )}
      {d && tab.t === 'atendimento' && (
        <>
          <div className="kpis">
            <Stat label="Atendimentos (conversas)" value={num(d.conversations)} foot={`${num(d.closed)} encerrados`} />
            <Stat label="Tempo médio de resposta" value={duration(d.response.avg_seconds)} foot={`mediana ${duration(d.response.median_seconds)} · ${d.response.replied}/${d.response.waits} respondidas`} />
            <Stat label="Tempo até 1º contato" value={duration(d.first_contact.avg_seconds)} foot={`mediana ${duration(d.first_contact.median_seconds)}`} />
            <Stat label="Duração média do atendimento" value={duration(d.avg_duration_seconds)} />
            <Stat label="Leads sem contato" value={num(d.pending.leads_without_contact)} foot={`${d.first_contact.without_contact} dos ${d.first_contact.leads} do período`} />
            <Stat label="Aguardando resposta agora" value={num(d.pending.awaiting_conversations)} foot={`${d.pending.pending_conversations} pendentes`} />
          </div>
          <Card title="Produtividade comercial por vendedor">
            <Table head={['Vendedor', 'Conversas', 'Msgs enviadas', 'Encerrados', 'Resp. média', 'Tarefas feitas', 'Vencidas', 'Contatos', 'Mov. funil', 'Aguardando']}
              rows={d.bySeller.map((r: any) => [r.name, num(r.conversations), num(r.messages_sent), num(r.conversations_closed), duration(r.avg_response_seconds), num(r.tasks_done), num(r.tasks_overdue), num(r.contacts_logged), num(r.stage_moves), num(r.awaiting_now)])} />
          </Card>
        </>
      )}
      {d && tab.t === 'vendas' && (
        <>
          <div className="kpis">
            <Stat label="Vendas" value={num(d.sales)} foot={`Anterior: ${num(d.previous.sales)}`} />
            <Stat label="Faturamento" value={money(d.revenue)} foot={`Anterior: ${money(d.previous.revenue)}`} />
            <Stat label="Ticket médio" value={money(d.avg_ticket)} />
            <Stat label="Conversão (leads do período)" value={pct(d.conversion_rate)} foot={`${d.cohort.converted} de ${d.cohort.leads}`} />
            <Stat label="Tempo médio até o fechamento" value={d.avg_days_to_close !== null ? `${d.avg_days_to_close.toLocaleString('pt-BR')} dias` : '—'} foot={d.avg_days_lead_to_sale !== null ? `${d.avg_days_lead_to_sale.toLocaleString('pt-BR')} dias desde a entrada do lead` : undefined} />
          </div>
          <div className="grid cols-2">
            <Card title="Vendas no período"><TimeLines data={d.series} series={[{ key: 'sales', name: 'Vendas' }]} granularity={g} /></Card>
            <Card title="Faturamento no período"><TimeBars data={d.series} dataKey="revenue" name="Faturamento" granularity={g} format="money" /></Card>
            <Card title="Por vendedor"><Table head={['Vendedor', 'Vendas', 'Faturamento', 'Ticket']} rows={d.bySeller.map((r: any) => [r.seller, num(r.sales), money(r.revenue), money(r.avg_ticket)])} /></Card>
            <Card title="Conversão por vendedor"><Table head={['Vendedor', 'Leads', 'Convertidos', 'Conversão']} rows={d.sellerConversion.map((r: any) => [r.seller, num(r.leads), num(r.converted), pct(r.conversion_rate)])} /></Card>
            <Card title="Por curso"><Table head={['Curso', 'Vendas', 'Faturamento', 'Ticket']} rows={d.byCourse.map((r: any) => [r.course, num(r.sales), money(r.revenue), money(r.avg_ticket)])} /></Card>
            <Card title="Por origem"><Table head={['Origem', 'Vendas', 'Faturamento', 'Ticket']} rows={d.bySource.map((r: any) => [r.source, num(r.sales), money(r.revenue), money(r.avg_ticket)])} /></Card>
            <Card title="Por campanha"><Table head={['Campanha', 'Vendas', 'Faturamento', 'Ticket']} rows={d.byCampaign.map((r: any) => [r.campaign, num(r.sales), money(r.revenue), money(r.avg_ticket)])} /></Card>
            <Card title="Motivos de perda"><BarList items={d.lostReasons.map((r: any) => ({ label: r.reason, value: r.count, sub: money(r.value) }))} empty="Nenhuma perda registrada no período" /></Card>
          </div>
        </>
      )}
      {d && tab.t === 'funil' && (
        <>
          <Card title={`Conversão entre etapas — ${d.created} oportunidades criadas no período`}>
            {d.stages.map((s: any) => (
              <div key={s.id} className="funnel-row">
                <span className="ellipsis">{s.name}</span>
                <div className="track"><div className="fill" style={{ width: `${Math.max(2, s.reached_pct ?? 0)}%`, background: s.color }}>{s.reached}</div></div>
                <span className="small">{pct(s.reached_pct)}{s.to_next_pct !== null && <div className="muted">→ {pct(s.to_next_pct)}</div>}</span>
              </div>
            ))}
          </Card>
          <Card title="Desempenho por etapa">
            <Table head={['Etapa', 'Alcançaram', '% do total', 'Passaram p/ próxima', 'Tempo médio na etapa', 'Atual (qtd)', 'Atual (valor)', 'Idade média']}
              rows={d.stages.map((s: any) => [s.name, num(s.reached), pct(s.reached_pct), pct(s.to_next_pct), duration(s.avg_seconds_in_stage), num(s.current_count), money(s.current_value), duration(s.avg_age_seconds)])} />
          </Card>
        </>
      )}
      {d && tab.t === 'marketing' && (
        <>
          {!d.totals.has_spend_data && <div className="alert info">CPL, CPA e ROAS só são calculados quando há investimento registrado (lançamento manual em Configurações › Campanhas ou integração Meta Ads Insights). Nenhum valor é estimado.</div>}
          <div className="kpis">
            <Stat label="Campanhas que geraram leads" value={num(d.totals.campaigns_with_leads)} />
            <Stat label="Campanhas que geraram vendas" value={num(d.totals.campaigns_with_sales)} />
            <Stat label="Investimento registrado" value={d.totals.spend !== null ? money(d.totals.spend) : '—'} />
            <Stat label="CPL" value={d.totals.cpl !== null ? money(d.totals.cpl) : '—'} foot="custo por lead (campanhas com investimento)" />
            <Stat label="CPA" value={d.totals.cpa !== null ? money(d.totals.cpa) : '—'} foot="custo por venda" />
            <Stat label="ROAS" value={d.totals.roas !== null ? `${d.totals.roas.toLocaleString('pt-BR')}x` : '—'} foot="receita atribuída ÷ investimento" />
          </div>
          <Card title="Campanhas">
            <Table head={['Campanha', 'Leads', 'Vendas', 'Conversão', 'Faturamento', 'Investimento', 'CPL', 'CPA', 'ROAS']}
              rows={d.campaigns.map((c: any) => [<span key="n">{c.name}<div className="cell-sub">{[c.channel, c.utm_campaign].filter(Boolean).join(' · ')}</div></span>, num(c.leads), num(c.sales), pct(c.conversion_rate), money(c.revenue), c.spend !== null ? money(c.spend) : '—', c.cpl !== null ? money(c.cpl) : '—', c.cpa !== null ? money(c.cpa) : '—', c.roas !== null ? `${c.roas}x` : '—'])} />
          </Card>
          <Card title="Parâmetros UTM identificados">
            <Table head={['utm_source / medium / campaign', 'Leads', 'Convertidos', 'Conversão', 'Faturamento']} rows={d.utm.map((r: any) => [`${r.utm_source} / ${r.utm_medium} / ${r.utm_campaign}`, num(r.leads), num(r.converted), pct(r.conversion_rate), money(r.revenue)])} />
          </Card>
        </>
      )}
    </div>
  );
}
