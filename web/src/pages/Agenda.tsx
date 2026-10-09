import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { CompleteTaskModal, TaskFormModal } from '../components/forms';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, MultiSelect, Tabs, usePersistentState, useConfirm, useToast } from '../components/ui';
import { addDays, fmtDateTime, fmtPhone, fmtTime, fmtWeekday, isoToLocal, localDate, localToIso, relative, TASK_ICONS, TASK_TYPES } from '../format';
import { useUsers } from '../hooks';

type View = 'list' | 'day' | 'week' | 'month';

function startOfWeek(d: string) {
  const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

export default function Agenda() {
  const { user, isManager } = useAuth();
  const [sp, setSp] = useSearchParams();
  const { data: users } = useUsers();
  const [s, setS] = usePersistentState('agenda', { view: 'list' as View, assignee: [] as string[], types: [] as string[], showDone: false });
  const [cursor, setCursor] = useState(localDate());
  const [modal, setModal] = useState<ReactNode>(null);
  const [openTask, setOpenTask] = useState<number | null>(null);
  useEffect(() => {
    const t = sp.get('task');
    if (t) {
      setOpenTask(Number(t));
      setSp({}, { replace: true });
    }
  }, [sp]); // eslint-disable-line

  const range = useMemo(() => {
    if (s.view === 'day') return { from: cursor, to: addDays(cursor, 1) };
    if (s.view === 'week') {
      const st = startOfWeek(cursor);
      return { from: st, to: addDays(st, 7) };
    }
    if (s.view === 'month') {
      const first = `${cursor.slice(0, 7)}-01`;
      const st = startOfWeek(first);
      return { from: st, to: addDays(st, 42) };
    }
    return null;
  }, [s.view, cursor]);

  const assignee = isManager ? s.assignee : [String(user!.id)];
  const listParams = { assignee_id: assignee, type: s.types, status: 'pending', limit: 500 };
  const rangeParams = range ? { assignee_id: assignee, type: s.types, from: localToIso(range.from, '00:00'), to: localToIso(range.to, '00:00'), status: s.showDone ? undefined : 'pending,done', limit: 2000 } : null;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tasks', s.view, rangeParams ?? listParams],
    queryFn: () => api.get('/api/tasks', rangeParams ?? listParams),
  });
  const { data: summary } = useQuery({ queryKey: ['task-summary', assignee], queryFn: () => api.get('/api/tasks/summary', { assignee_id: assignee }) });
  const tasks: any[] = data ?? [];

  const move = (n: number) => {
    if (s.view === 'day') setCursor(addDays(cursor, n));
    else if (s.view === 'week') setCursor(addDays(cursor, 7 * n));
    else {
      const [y, m] = cursor.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      setCursor(d.toISOString().slice(0, 10));
    }
  };
  const title = s.view === 'day' ? fmtWeekday(`${cursor}T12:00:00Z`) : s.view === 'week' ? `Semana de ${startOfWeek(cursor).split('-').reverse().join('/')}` : s.view === 'month' ? new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${cursor.slice(0, 7)}-15T12:00:00Z`)) : '';
  const byDay = (day: string) => tasks.filter((t) => isoToLocal(t.due_at).date === day);

  return (
    <div>
      <div className="page-head">
        <h1>Agenda</h1>
        <span className="sub">
          <b style={{ color: summary?.overdue ? 'var(--danger)' : undefined }}>{summary?.overdue ?? 0} vencidas</b> · {summary?.today ?? 0} hoje · {summary?.next_hour ?? 0} na próxima hora · {summary?.done_today ?? 0} concluídas hoje
        </span>
        <span className="grow" />
        <button className="btn primary" onClick={() => setModal(<TaskFormModal onClose={() => setModal(null)} />)}>+ Nova atividade</button>
      </div>
      <Tabs value={s.view} onChange={(v) => setS({ ...s, view: v })} items={[{ value: 'list', label: 'Pendências' }, { value: 'day', label: 'Dia' }, { value: 'week', label: 'Semana' }, { value: 'month', label: 'Mês' }]} />
      <div className="filters">
        {s.view !== 'list' && (
          <div className="btn-row">
            <button className="btn" onClick={() => move(-1)}>‹</button>
            <button className="btn" onClick={() => setCursor(localDate())}>Hoje</button>
            <button className="btn" onClick={() => move(1)}>›</button>
            <b style={{ textTransform: 'capitalize', marginLeft: 6 }}>{title}</b>
          </div>
        )}
        <span className="spacer" />
        {isManager && <Field label="Responsável"><MultiSelect placeholder="Toda a equipe" options={(users ?? []).map((u) => ({ value: String(u.id), label: u.name }))} value={s.assignee} onChange={(v) => setS({ ...s, assignee: v })} /></Field>}
        <Field label="Tipo"><MultiSelect options={Object.entries(TASK_TYPES).map(([value, label]) => ({ value, label }))} value={s.types} onChange={(v) => setS({ ...s, types: v })} /></Field>
        {s.view !== 'list' && <label className="check"><input type="checkbox" checked={s.showDone} onChange={(e) => setS({ ...s, showDone: e.target.checked })} /> Incluir canceladas</label>}
      </div>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={refetch} />}
      {data && s.view === 'list' && <ListView tasks={tasks} onOpen={setOpenTask} />}
      {data && s.view === 'day' && (
        <div className="card">{byDay(cursor).length ? byDay(cursor).map((t) => <TaskRow key={t.id} t={t} onOpen={setOpenTask} />) : <Empty icon="🗓️" text="Nenhuma atividade neste dia." />}</div>
      )}
      {data && s.view === 'week' && (
        <div className="week">
          {Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i)).map((day) => (
            <div key={day} className={`day ${day === localDate() ? 'today' : ''}`}>
              <div className="day-head"><span style={{ textTransform: 'capitalize' }}>{new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))}</span><span className="muted">{byDay(day).length}</span></div>
              <div className="day-body">{byDay(day).map((t) => <MiniTask key={t.id} t={t} onOpen={setOpenTask} />)}</div>
            </div>
          ))}
        </div>
      )}
      {data && s.view === 'month' && range && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="cal">
            {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => <div key={d} className="dow">{d}</div>)}
            {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((day) => {
              const list = byDay(day);
              return (
                <div key={day} className={`cell ${day.slice(0, 7) !== cursor.slice(0, 7) ? 'other' : ''} ${day === localDate() ? 'today' : ''}`} onClick={() => { setCursor(day); setS({ ...s, view: 'day' }); }}>
                  <div className="dn">{Number(day.slice(8))}</div>
                  {list.slice(0, 4).map((t) => <div key={t.id} className={`ev ${t.status === 'done' ? 'done' : t.overdue ? 'overdue' : ''}`} title={t.title}>{fmtTime(t.due_at)} {t.title}</div>)}
                  {list.length > 4 && <div className="small muted">+{list.length - 4}</div>}
                  {list.length > 0 && <div className="cnt">{list.length} ativ.</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {openTask && <TaskDetail id={openTask} onClose={() => setOpenTask(null)} />}
      {modal}
    </div>
  );
}

function ListView({ tasks, onOpen }: { tasks: any[]; onOpen: (id: number) => void }) {
  const today = localDate();
  const groups: [string, any[]][] = [
    ['Vencidas', tasks.filter((t) => t.overdue)],
    ['Hoje', tasks.filter((t) => !t.overdue && isoToLocal(t.due_at).date === today)],
    ['Amanhã', tasks.filter((t) => isoToLocal(t.due_at).date === addDays(today, 1))],
    ['Próximos dias', tasks.filter((t) => isoToLocal(t.due_at).date > addDays(today, 1))],
  ];
  if (!tasks.length) return <div className="card"><Empty icon="🎉" text="Nenhuma atividade pendente." /></div>;
  return (
    <div className="stack">
      {groups.filter(([, l]) => l.length).map(([name, list]) => (
        <div key={name} className="card">
          <div className="card-head"><h3 style={{ color: name === 'Vencidas' ? 'var(--danger)' : undefined }}>{name} ({list.length})</h3></div>
          {list.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpen} />)}
        </div>
      ))}
    </div>
  );
}

function TaskRow({ t, onOpen }: { t: any; onOpen: (id: number) => void }) {
  const [modal, setModal] = useState<ReactNode>(null);
  return (
    <div className={`task-row ${t.overdue ? 'overdue' : ''} ${t.status}`}>
      <span style={{ fontSize: 18 }}>{TASK_ICONS[t.type]}</span>
      <div style={{ cursor: 'pointer', minWidth: 0 }} onClick={() => onOpen(t.id)}>
        <div className="title cell-main ellipsis">{t.title}</div>
        <div className="cell-sub when">
          {fmtDateTime(t.due_at)} ({relative(t.due_at)}) · {TASK_TYPES[t.type]} · {t.assignee_name ?? '—'}
          {t.lead_id && <> · <Link to={`/leads/${t.lead_id}`} onClick={(e) => e.stopPropagation()}>{t.lead_name}</Link> {t.lead_phone && fmtPhone(t.lead_phone)}</>}
        </div>
      </div>
      <div className="btn-row">
        {t.status === 'pending' && <button className="btn sm success" onClick={() => setModal(<CompleteTaskModal task={t} onClose={() => setModal(null)} />)}>Concluir</button>}
        {t.status === 'done' && <Badge color="green">Concluída</Badge>}
      </div>
      {modal}
    </div>
  );
}

function MiniTask({ t, onOpen }: { t: any; onOpen: (id: number) => void }) {
  return (
    <div className={`task-mini ${t.overdue ? 'overdue' : ''} ${t.status === 'done' ? 'done' : ''}`} onClick={() => onOpen(t.id)} title={t.title}>
      <b>{fmtTime(t.due_at)}</b> {TASK_ICONS[t.type]} {t.title}
      {t.lead_name && <div className="muted ellipsis">{t.lead_name}</div>}
    </div>
  );
}

function TaskDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [modal, setModal] = useState<ReactNode>(null);
  const { data: t, isLoading, error } = useQuery({ queryKey: ['tasks', 'detail', id], queryFn: () => api.get(`/api/tasks/${id}`) });
  const act = async (fn: () => Promise<any>, msg: string) => {
    try {
      await fn();
      toast(msg);
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-summary'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  if (modal) return <>{modal}</>;
  return (
    <Modal title="Atividade" onClose={onClose} footer={t && (
      <>
        <button className="btn ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={async () => (await confirm({ title: 'Excluir atividade?', danger: true, confirm: 'Excluir' })) && act(() => api.del(`/api/tasks/${id}`), 'Atividade excluída').then(onClose)}>Excluir</button>
        {t.status === 'pending' && <button className="btn" onClick={() => act(() => api.post(`/api/tasks/${id}/cancel`), 'Atividade cancelada')}>Cancelar atividade</button>}
        {t.status !== 'pending' && <button className="btn" onClick={() => act(() => api.post(`/api/tasks/${id}/reopen`), 'Atividade reaberta')}>Reabrir</button>}
        {t.status === 'pending' && <button className="btn" onClick={() => setModal(<TaskFormModal task={t} onClose={() => setModal(null)} />)}>Editar / reagendar</button>}
        {t.status === 'pending' && <button className="btn success" onClick={() => setModal(<CompleteTaskModal task={t} onClose={() => { setModal(null); onClose(); }} />)}>Concluir</button>}
      </>
    )}>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {t && (
        <div className="stack">
          <div className="row wrap"><span style={{ fontSize: 20 }}>{TASK_ICONS[t.type]}</span><h2>{t.title}</h2>{t.overdue && <Badge color="red">Vencida</Badge>}{t.status === 'done' && <Badge color="green">Concluída</Badge>}{t.status === 'canceled' && <Badge>Cancelada</Badge>}</div>
          <div className="kv">
            <span className="k">Tipo</span><span>{TASK_TYPES[t.type]}</span>
            <span className="k">Quando</span><span>{fmtDateTime(t.due_at)} ({t.duration_minutes} min)</span>
            <span className="k">Responsável</span><span>{t.assignee_name ?? '—'}</span>
            <span className="k">Criada por</span><span>{t.created_by_name ?? (t.source === 'automation' ? 'Automação' : '—')}</span>
            {t.lead_id && (<><span className="k">Lead</span><span><Link to={`/leads/${t.lead_id}`} onClick={onClose}>{t.lead_name}</Link> {fmtPhone(t.lead_phone)}</span></>)}
            {t.opportunity_title && (<><span className="k">Oportunidade</span><span>{t.opportunity_title}</span></>)}
            {t.reschedule_count > 0 && (<><span className="k">Reagendada</span><span>{t.reschedule_count}x</span></>)}
            {t.completed_at && (<><span className="k">Concluída em</span><span>{fmtDateTime(t.completed_at)}</span></>)}
            {t.outcome && (<><span className="k">Resultado</span><span>{t.outcome}</span></>)}
          </div>
          {t.description && <div style={{ whiteSpace: 'pre-wrap' }}>{t.description}</div>}
        </div>
      )}
    </Modal>
  );
}
