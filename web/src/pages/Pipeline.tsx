import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { LoseModal, OpportunityDrawer, WinModal } from '../components/forms';
import { ErrorBox, Field, Loading, MultiSelect, useDebounced, usePersistentState, useToast } from '../components/ui';
import { duration, fmtDate, moneyShort, money } from '../format';
import { useCampaigns, useCourses, usePipelines, useUsers } from '../hooks';

function OppCard({ o, overlay }: { o: any; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: o.id, data: o, disabled: overlay });
  return (
    <div ref={overlay ? undefined : setNodeRef} {...(overlay ? {} : listeners)} {...(overlay ? {} : attributes)} data-opp={o.id}
      className={`opp-card ${isDragging ? 'dragging' : ''} ${overlay ? 'drag-overlay' : ''} ${o.is_stale ? 'stale' : ''}`}>
      <div className="t">{o.lead_name}</div>
      <div className="l ellipsis">{o.course_name ?? o.title}</div>
      <div className="m">
        <b style={{ color: 'var(--text)' }}>{money(o.status === 'won' ? o.sale_value : o.value)}</b>
        <span>· {duration(o.seconds_in_stage)}</span>
        {o.awaiting_reply && <span title="Cliente aguardando resposta">💬</span>}
        {o.is_stale && <span title="Parada além do limite da etapa">⚠️</span>}
        {o.next_task_at ? <span title="Próximo acompanhamento">📅 {fmtDate(o.next_task_at)}</span> : o.status === 'open' ? <span title="Sem acompanhamento agendado" style={{ color: 'var(--warning)' }}>sem retorno</span> : null}
      </div>
      <div className="m" style={{ marginTop: 4 }}><span>{o.owner_name ?? 'Sem responsável'}</span>{o.expected_close_date && <span>· prev. {fmtDate(o.expected_close_date)}</span>}</div>
    </div>
  );
}

function Column({ stage, children }: { stage: any; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}`, data: stage });
  return (
    <div className={`column ${isOver ? 'over' : ''}`} ref={setNodeRef}>
      <div className="column-head" style={{ borderTop: `3px solid ${stage.color}`, borderRadius: '10px 10px 0 0' }}>
        <div className="name">{stage.name}{stage.kind === 'won' ? ' ✓' : stage.kind === 'lost' ? ' ✕' : ''} <span className="muted small">({stage.count})</span></div>
        <div className="meta">{moneyShort(stage.total)}{stage.kind !== 'open' ? ' · últimos 30 dias' : ''}{stage.count > stage.opportunities.length ? ` · exibindo ${stage.opportunities.length}` : ''}</div>
      </div>
      <div className="column-body">{children}</div>
    </div>
  );
}

export default function Pipeline() {
  const { isManager } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const { data: pipelines } = usePipelines();
  const { data: users } = useUsers();
  const { data: courses } = useCourses();
  const { data: campaigns } = useCampaigns();
  const [f, setF] = usePersistentState('pipeline-filters', { pipeline_id: 0, owner_id: [] as string[], course_id: [] as string[], campaign_id: [] as string[], q: '', stale: false, from: '', to: '' });
  const [drawer, setDrawer] = useState<number | null>(null);
  const [modal, setModal] = useState<ReactNode>(null);
  const [dragging, setDragging] = useState<any>(null);
  const activePipelines = pipelines?.filter((p) => p.active) ?? [];
  const pipelineId = activePipelines.some((p) => p.id === f.pipeline_id) ? f.pipeline_id : (activePipelines.find((p) => p.is_default) ?? activePipelines[0])?.id;
  const dq = useDebounced(f.q, 300);
  useEffect(() => {
    const opp = sp.get('opp');
    if (opp) setDrawer(Number(opp));
    if (sp.get('stale')) setF((x: any) => ({ ...x, stale: true }));
    if (sp.toString()) setSp({}, { replace: true });
  }, []); // eslint-disable-line
  const params = { pipeline_id: pipelineId, owner_id: f.owner_id, course_id: f.course_id, campaign_id: f.campaign_id, q: dq, stale: f.stale || undefined, from: f.from, to: f.to };
  const key = ['board', params];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get('/api/board', params), enabled: !!pipelineId });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }));
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const totals = useMemo(() => {
    const open = data?.stages.filter((s: any) => s.kind === 'open') ?? [];
    return { count: open.reduce((a: number, s: any) => a + s.count, 0), value: open.reduce((a: number, s: any) => a + s.total, 0), weighted: open.reduce((a: number, s: any) => a + (s.total * s.probability) / 100, 0) };
  }, [data]);

  const onStart = (e: DragStartEvent) => setDragging(e.active.data.current);
  const onEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const opp = e.active.data.current as any;
    const stage = e.over?.data.current as any;
    if (!opp || !stage || stage.id === opp.stage_id) return;
    if (stage.kind === 'won') return setModal(<WinModal opp={opp} stageId={stage.id} onClose={() => setModal(null)} onDone={() => refetch()} />);
    if (stage.kind === 'lost') return setModal(<LoseModal opp={opp} stageId={stage.id} onClose={() => setModal(null)} onDone={() => refetch()} />);
    // atualização otimista
    const prev = qc.getQueryData(key);
    qc.setQueryData(key, (d: any) => d && {
      ...d,
      stages: d.stages.map((s: any) => ({
        ...s,
        opportunities: s.id === stage.id ? [{ ...opp, stage_id: stage.id, seconds_in_stage: 0 }, ...s.opportunities] : s.opportunities.filter((o: any) => o.id !== opp.id),
        count: s.id === stage.id ? s.count + 1 : s.id === opp.stage_id ? s.count - 1 : s.count,
      })),
    });
    try {
      await api.post(`/api/opportunities/${opp.id}/move`, { stage_id: stage.id });
      toast(`${opp.lead_name} → ${stage.name}`);
    } catch (err) {
      qc.setQueryData(key, prev);
      toast((err as Error).message, 'error');
    } finally {
      refetch();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '14px 16px 0' }}>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <h1>Funil de vendas</h1>
          <select className="select" style={{ width: 'auto' }} value={pipelineId ?? ''} onChange={(e) => set('pipeline_id', Number(e.target.value))}>
            {activePipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="sub">{totals.count} em andamento · {money(totals.value)} · ponderado {money(totals.weighted)}</span>
        </div>
        <div className="filters" style={{ marginBottom: 8 }}>
          <Field label="Buscar" className="wide"><input className="input" value={f.q} onChange={(e) => set('q', e.target.value)} placeholder="Lead, telefone ou título" /></Field>
          {isManager && <Field label="Vendedor"><MultiSelect options={[{ value: 'none', label: 'Sem responsável' }, ...(users ?? []).map((u) => ({ value: String(u.id), label: u.name }))]} value={f.owner_id} onChange={(v) => set('owner_id', v)} /></Field>}
          <Field label="Curso"><MultiSelect options={(courses ?? []).map((c) => ({ value: String(c.id), label: c.name }))} value={f.course_id} onChange={(v) => set('course_id', v)} /></Field>
          <Field label="Campanha"><MultiSelect options={(campaigns ?? []).map((c) => ({ value: String(c.id), label: c.name }))} value={f.campaign_id} onChange={(v) => set('campaign_id', v)} /></Field>
          <Field label="Criadas de"><input className="input" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="até"><input className="input" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>
          <label className="check"><input type="checkbox" checked={f.stale} onChange={(e) => set('stale', e.target.checked)} /> Somente paradas</label>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '0 12px' }}>
        {isLoading && <Loading />}
        {error && <ErrorBox error={error} retry={refetch} />}
        {data && (
          <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
            <div className="board">
              {data.stages.map((s: any) => (
                <Column key={s.id} stage={s}>
                  {s.opportunities.map((o: any) => (
                    <div key={o.id} onClick={() => setDrawer(o.id)}><OppCard o={o} /></div>
                  ))}
                  {!s.opportunities.length && <div className="muted small" style={{ textAlign: 'center', padding: 10 }}>Arraste oportunidades para cá</div>}
                </Column>
              ))}
            </div>
            <DragOverlay>{dragging ? <OppCard o={dragging} overlay /> : null}</DragOverlay>
          </DndContext>
        )}
      </div>
      {drawer && <OpportunityDrawer id={drawer} onClose={() => { setDrawer(null); refetch(); }} />}
      {modal}
    </div>
  );
}
