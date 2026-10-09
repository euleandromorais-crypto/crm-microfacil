import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { CompleteTaskModal, LeadFormModal, NewOpportunityModal, OpportunityDrawer, StatusBadge, TagList, TaskFormModal, UserSelect } from '../components/forms';
import { Badge, ErrorBox, Field, Loading, Modal, Tabs, useConfirm, useToast } from '../components/ui';
import { duration, fmtDate, fmtDateTime, fmtPhone, money, relative, STATUS_LABELS, TASK_ICONS, TASK_TYPES } from '../format';
import { useCustomFields, useUsers } from '../hooks';

export default function LeadProfile() {
  const { id } = useParams();
  const leadId = Number(id);
  const { isManager, isAdmin } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<'timeline' | 'opps' | 'tasks' | 'convs' | 'data'>('timeline');
  const [modal, setModal] = useState<ReactNode>(null);
  const [oppId, setOppId] = useState<number | null>(null);
  const { data: lead, isLoading, error, refetch } = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.get(`/api/leads/${leadId}`) });
  const { data: fields } = useCustomFields();
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  if (lead?.redirect) return <Navigate to={`/leads/${lead.redirect}`} replace />;
  const close = () => setModal(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lead', leadId] });
    qc.invalidateQueries({ queryKey: ['timeline', leadId] });
  };
  const patch = async (body: any, msg: string) => {
    try {
      await api.patch(`/api/leads/${leadId}`, body);
      toast(msg);
      refresh();
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const openWhatsApp = async () => {
    try {
      const r = await api.post(`/api/leads/${leadId}/conversation`);
      nav(`/conversas/${r.id}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Excluir lead?', text: `${lead.name} será removido das listas e relatórios. O histórico é mantido para auditoria.`, danger: true, confirm: 'Excluir' }))) return;
    await api.del(`/api/leads/${leadId}`);
    toast('Lead excluído');
    nav('/leads');
  };
  const anonymize = async () => {
    if (!(await confirm({ title: 'Anonimizar dados pessoais (LGPD)?', text: 'Remove nome, telefone, e-mail, documentos, notas e conteúdo das mensagens deste titular, mantendo apenas dados agregados. Irreversível.', danger: true, confirm: 'Anonimizar' }))) return;
    await api.post(`/api/leads/${leadId}/anonymize`);
    toast('Dados anonimizados');
    nav('/leads');
  };
  const openTasks = lead.tasks.filter((t: any) => t.status === 'pending');
  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="row wrap">
              <h1>{lead.name}</h1>
              <StatusBadge status={lead.status} />
              {lead.reactivation_flag && <Badge color="amber">♻️ Reativação</Badge>}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              {lead.phone && <span>📱 {fmtPhone(lead.phone)} </span>}
              {lead.email && <span>· ✉️ {lead.email} </span>}
              <span>· Entrada {fmtDateTime(lead.created_at)}</span>
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              {lead.course_name && <span>🎓 {lead.course_name} · </span>}
              <span>Origem: {lead.source ?? '—'}</span>
              {lead.campaign_name && <span> · Campanha: {lead.campaign_name}</span>}
              {lead.utm_source && <span className="muted"> · utm: {lead.utm_source}/{lead.utm_medium ?? '—'}/{lead.utm_campaign ?? '—'}</span>}
            </div>
            <div style={{ marginTop: 6 }}><TagList ids={lead.tag_ids} /></div>
            <div className="small muted" style={{ marginTop: 6 }}>
              Primeiro contato: {lead.first_contact_at ? `${fmtDateTime(lead.first_contact_at)} (${duration((new Date(lead.first_contact_at).getTime() - new Date(lead.created_at).getTime()) / 1000)} após a entrada)` : <b style={{ color: 'var(--danger)' }}>ainda não realizado</b>}
              {' · '}Última interação: {relative(lead.last_interaction_at)}
            </div>
          </div>
          <div className="stack" style={{ gap: 8, minWidth: 240 }}>
            <Field label="Status comercial">
              <select className="select" value={lead.status} onChange={(e) => patch({ status: e.target.value }, 'Status atualizado')}>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Responsável">
              {isManager ? <UserSelect value={lead.owner_id} onChange={(v) => patch({ owner_id: v }, 'Responsável atualizado')} /> : <input className="input" disabled value={lead.owner_name ?? 'Sem responsável'} />}
            </Field>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 14 }}>
          {lead.phone && <button className="btn primary" onClick={openWhatsApp}>💬 WhatsApp</button>}
          <button className="btn" onClick={() => setModal(<ContactModal leadId={leadId} onClose={close} onDone={refresh} />)}>📞 Registrar contato</button>
          <button className="btn" onClick={() => setModal(<TaskFormModal defaults={{ lead_id: leadId, leadName: lead.name, title: `Retornar para ${lead.name}` }} onClose={close} onSaved={refresh} />)}>📅 Agendar</button>
          <button className="btn" onClick={() => setModal(<NewOpportunityModal leadId={leadId} leadName={lead.name} onClose={close} />)}>+ Oportunidade</button>
          <button className="btn" onClick={() => setModal(<LeadFormModal lead={lead} onClose={close} />)}>Editar</button>
          {isManager && <button className="btn ghost" style={{ color: 'var(--danger)' }} onClick={remove}>Excluir</button>}
          {isAdmin && <button className="btn ghost" onClick={anonymize}>Anonimizar (LGPD)</button>}
        </div>
      </div>

      {openTasks.length > 0 && (
        <div className="alert info row wrap">
          <b>Próximos compromissos:</b>
          {openTasks.slice(0, 3).map((t: any) => (
            <span key={t.id} style={{ color: new Date(t.due_at) < new Date() ? 'var(--danger)' : undefined }}>{TASK_ICONS[t.type]} {t.title} — {fmtDateTime(t.due_at)}</span>
          ))}
        </div>
      )}

      <div className="card card-pad">
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'timeline', label: 'Histórico' },
          { value: 'opps', label: 'Oportunidades', count: lead.opportunities.length },
          { value: 'tasks', label: 'Atividades', count: openTasks.length },
          { value: 'convs', label: 'Conversas', count: lead.conversations.length },
          { value: 'data', label: 'Dados cadastrais' },
        ]} />
        {tab === 'timeline' && <Timeline leadId={leadId} />}
        {tab === 'opps' && (
          <div className="table-wrap">
            {!lead.opportunities.length && <div className="muted">Nenhuma oportunidade. Crie uma para acompanhar a negociação no funil.</div>}
            {lead.opportunities.length > 0 && (
              <table className="table">
                <thead><tr><th>Oportunidade</th><th>Funil / etapa</th><th className="num">Valor</th><th>Responsável</th><th>Situação</th></tr></thead>
                <tbody>
                  {lead.opportunities.map((o: any) => (
                    <tr key={o.id} className="clickable" onClick={() => setOppId(o.id)}>
                      <td className="cell-main">{o.title}<div className="cell-sub">{o.course_name ?? ''}</div></td>
                      <td>{o.pipeline_name} · <span style={{ color: o.stage_color }}>●</span> {o.stage_name}</td>
                      <td className="num">{money(o.status === 'won' ? o.sale_value : o.value)}</td>
                      <td>{o.owner_name ?? '—'}</td>
                      <td>{o.status === 'won' ? <Badge color="green">Ganha {fmtDate(o.won_at)}</Badge> : o.status === 'lost' ? <Badge color="red">Perdida{o.lost_reason ? `: ${o.lost_reason}` : ''}</Badge> : <Badge color="blue">Em andamento</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {tab === 'tasks' && <LeadTasks lead={lead} onChange={refresh} />}
        {tab === 'convs' && (
          <div>
            {!lead.conversations.length && <div className="muted">Nenhuma conversa de WhatsApp. {lead.phone && <button className="btn sm" onClick={openWhatsApp}>Iniciar conversa</button>}</div>}
            {lead.conversations.map((c: any) => (
              <Link key={c.id} to={`/conversas/${c.id}`} className="card card-pad row" style={{ marginBottom: 8, color: 'inherit' }}>
                <span className="spacer">
                  <b>+{c.contact_wa_id}</b> · {c.status === 'closed' ? 'Encerrada' : c.status === 'pending' ? 'Pendente' : 'Aberta'} · {c.assignee_name ?? 'sem responsável'}
                  <div className="small muted">{c.last_message_preview} · {relative(c.last_message_at)}</div>
                </span>
                {c.awaiting_reply && <Badge color="amber">Aguardando resposta</Badge>}
                {c.unread_count > 0 && <span className="unread">{c.unread_count}</span>}
              </Link>
            ))}
          </div>
        )}
        {tab === 'data' && (
          <div className="grid cols-2">
            <div className="kv">
              <span className="k">Telefone</span><span>{fmtPhone(lead.phone) || '—'}</span>
              <span className="k">E-mail</span><span>{lead.email ?? '—'}</span>
              <span className="k">Documento</span><span>{lead.document ?? '—'}</span>
              <span className="k">Nascimento</span><span>{fmtDate(lead.birth_date)}</span>
              <span className="k">Cidade/UF</span><span>{[lead.city, lead.state].filter(Boolean).join(' / ') || '—'}</span>
              <span className="k">Consentimento</span><span>{lead.consent_whatsapp ? `Sim (${fmtDateTime(lead.consent_at)})` : 'Não registrado'}</span>
              <span className="k">Cadastrado por</span><span>{lead.created_by_name ?? 'Integração / sistema'}</span>
              <span className="k">Ref. externa</span><span>{lead.external_ref ?? '—'}</span>
              <span className="k">Página</span><span className="ellipsis">{lead.referrer_url ?? '—'}</span>
              {['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((k) => (<Fragment key={k}><span className="k">{k}</span><span>{lead[k] ?? '—'}</span></Fragment>))}
            </div>
            <div>
              <div className="kv">
                {fields?.filter((f) => f.active).map((f) => (<Fragment key={f.key}><span className="k">{f.label}</span><span>{fmtCustom(lead.custom?.[f.key])}</span></Fragment>))}
              </div>
              <h3 style={{ marginTop: 14 }}>Observações internas</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{lead.notes ?? <span className="muted">—</span>}</div>
              <StatusHistory leadId={leadId} />
            </div>
          </div>
        )}
      </div>
      {modal}
      {oppId && <OpportunityDrawer id={oppId} onClose={() => { setOppId(null); refresh(); }} />}
    </div>
  );
}

const fmtCustom = (v: any) => (v === true ? 'Sim' : v === false ? 'Não' : v === null || v === undefined || v === '' ? '—' : String(v));

function StatusHistory({ leadId }: { leadId: number }) {
  const { data } = useQuery({ queryKey: ['lead', leadId, 'status'], queryFn: () => api.get(`/api/leads/${leadId}/status-history`) });
  return (
    <>
      <h3 style={{ marginTop: 14 }}>Histórico de status</h3>
      {data?.map((h: any) => (
        <div key={h.id} className="small" style={{ padding: '2px 0' }}>
          {fmtDateTime(h.created_at)} — {h.from_status ? `${STATUS_LABELS[h.from_status]} → ` : ''}<b>{STATUS_LABELS[h.to_status]}</b> <span className="muted">{h.user_name ?? 'sistema'}</span>
        </div>
      ))}
    </>
  );
}

function LeadTasks({ lead, onChange }: { lead: any; onChange: () => void }) {
  const [modal, setModal] = useState<ReactNode>(null);
  return (
    <div>
      {!lead.tasks.length && <div className="muted">Nenhuma atividade.</div>}
      {lead.tasks.map((t: any) => {
        const overdue = t.status === 'pending' && new Date(t.due_at) < new Date();
        return (
          <div key={t.id} className={`task-row ${overdue ? 'overdue' : ''} ${t.status}`}>
            <span>{TASK_ICONS[t.type]}</span>
            <div>
              <div className="title cell-main">{t.title}</div>
              <div className="cell-sub when">{TASK_TYPES[t.type]} · {fmtDateTime(t.due_at)} · {t.assignee_name ?? '—'} {t.outcome && `· Resultado: ${t.outcome}`}</div>
            </div>
            <div className="btn-row">
              {t.status === 'pending' && <button className="btn sm success" onClick={() => setModal(<CompleteTaskModal task={{ ...t, lead_name: lead.name }} onClose={() => { setModal(null); onChange(); }} />)}>Concluir</button>}
              {t.status === 'pending' && <button className="btn sm" onClick={() => setModal(<TaskFormModal task={t} onClose={() => setModal(null)} onSaved={onChange} />)}>Reagendar</button>}
              {t.status === 'done' && <Badge color="green">Concluída</Badge>}
              {t.status === 'canceled' && <Badge>Cancelada</Badge>}
            </div>
          </div>
        );
      })}
      {modal}
    </div>
  );
}

function ContactModal({ leadId, onClose, onDone }: { leadId: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ channel: 'call', reached: true, outcome: '' });
  const submit = async () => {
    try {
      await api.post(`/api/leads/${leadId}/contact`, f);
      toast('Contato registrado');
      onDone();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Registrar contato" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Registrar</button></>}>
      <div className="stack">
        <Field label="Canal">
          <select className="select" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="call">Ligação</option><option value="whatsapp_phone">WhatsApp (fora do CRM)</option><option value="email">E-mail</option><option value="presencial">Presencial</option><option value="other">Outro</option>
          </select>
        </Field>
        <label className="check"><input type="checkbox" checked={f.reached} onChange={(e) => setF({ ...f, reached: e.target.checked })} /> Conseguiu falar com o lead</label>
        <Field label="Resumo"><textarea className="textarea" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} autoFocus /></Field>
      </div>
    </Modal>
  );
}

const EVENT_ICONS: Record<string, string> = {
  created: '✨', reentry: '🔁', updated: '✏️', status_changed: '🏷️', owner_changed: '👤', note: '📝', contact_logged: '📞', whatsapp_in: '💬', whatsapp_out: '📤',
  opportunity_created: '💼', stage_changed: '➜', opportunity_won: '🎉', opportunity_lost: '✕', opportunity_reopened: '↺', opportunity_updated: '✏️', opportunity_deleted: '🗑️',
  task_created: '📅', task_done: '✅', task_rescheduled: '🕑', task_canceled: '⛔', merged: '🔗', conversation_closed: '🔒', conversation_assigned: '↪', intake_data: '📥', reactivation_flag: '♻️',
};

function EventText({ e, users }: { e: any; users: Map<number, string> }) {
  const d = e.data ?? {};
  const u = (id: number | null) => (id ? users.get(id) ?? `#${id}` : 'ninguém');
  switch (e.type) {
    case 'created': return <>Lead criado via <b>{d.via}</b>{d.source ? ` · origem ${d.source}` : ''}</>;
    case 'reentry': return <>Lead entrou novamente via <b>{d.via}</b>{d.source ? ` (${d.source})` : ''}{d.message ? <div className="tl-note">{d.message}</div> : null}</>;
    case 'updated': return <>Dados atualizados: {Object.keys(d.changes ?? {}).join(', ')}</>;
    case 'status_changed': return <>Status: {STATUS_LABELS[d.from] ?? d.from} → <b>{STATUS_LABELS[d.to] ?? d.to}</b>{d.auto ? ' (automático)' : ''}</>;
    case 'owner_changed': return <>Responsável: {u(d.from)} → <b>{u(d.to)}</b> <span className="muted">({d.reason})</span></>;
    case 'note': return <>Nota interna<div className="tl-note">{d.text}</div></>;
    case 'contact_logged': return <>Contato registrado ({d.channel}){d.reached === false ? ' — não atendeu' : ''}{d.outcome ? <div className="tl-note">{d.outcome}</div> : null}</>;
    case 'whatsapp_in': return <>💬 {d.count > 1 ? `${d.count} mensagens recebidas` : 'Mensagem recebida'}: <i>{d.last}</i></>;
    case 'whatsapp_out': return <>{d.count > 1 ? `${d.count} mensagens enviadas` : 'Mensagem enviada'}{d.template ? ` (modelo ${d.template})` : ''}: <i>{d.last}</i></>;
    case 'opportunity_created': return <>Oportunidade criada: <b>{d.title}</b> {d.value ? `· ${money(d.value)}` : ''}</>;
    case 'stage_changed': return <>{d.title}: {d.from} → <b>{d.to}</b></>;
    case 'opportunity_won': return <><b>Matrícula realizada</b> — {d.title} · {money(d.sale_value)}</>;
    case 'opportunity_lost': return <>Oportunidade perdida — {d.title}{d.reason ? ` · ${d.reason}` : ''}{d.note ? ` · ${d.note}` : ''}</>;
    case 'opportunity_reopened': return <>Oportunidade reaberta — {d.title}</>;
    case 'opportunity_updated': return <>Oportunidade atualizada — {d.title} ({Object.keys(d.changes ?? {}).join(', ')})</>;
    case 'task_created': return <>Atividade agendada: <b>{d.title}</b> para {fmtDateTime(d.due_at)}</>;
    case 'task_done': return <>Atividade concluída: <b>{d.title}</b>{d.outcome ? <div className="tl-note">{d.outcome}</div> : null}</>;
    case 'task_rescheduled': return <>Atividade reagendada: {d.title} → {fmtDateTime(d.to)}</>;
    case 'task_canceled': return <>Atividade cancelada: {d.title}</>;
    case 'merged': return <>Cadastros mesclados neste lead: {(d.names ?? []).join(', ')}</>;
    case 'conversation_closed': return <>Atendimento encerrado{d.reason ? `: ${d.reason}` : ''}</>;
    case 'conversation_assigned': return <>Conversa transferida: {u(d.from)} → <b>{u(d.to)}</b>{d.note ? ` — ${d.note}` : ''}</>;
    case 'intake_data': return <>Dados recebidos{d.via ? ` (${d.via})` : ''}: <span className="mono small">{Object.entries(d.extra ?? d).filter(([k]) => k !== 'via').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</span></>;
    case 'reactivation_flag': return <>Lead sinalizado para reativação</>;
    default: return <>{e.type}</>;
  }
}

function Timeline({ leadId }: { leadId: number }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const { data: usersList } = useUsers();
  const users = new Map((usersList ?? []).map((u) => [u.id, u.name]));
  const q = useInfiniteQuery({
    queryKey: ['timeline', leadId, filter],
    queryFn: ({ pageParam }) => api.get(`/api/leads/${leadId}/timeline`, { before: pageParam || undefined, type: filter || undefined }),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.hasMore ? last.rows[last.rows.length - 1].id : undefined),
  });
  const add = async () => {
    if (!note.trim()) return;
    try {
      await api.post(`/api/leads/${leadId}/notes`, { text: note });
      setNote('');
      qc.invalidateQueries({ queryKey: ['timeline', leadId] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const rows = q.data?.pages.flatMap((p: any) => p.rows) ?? [];
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <textarea className="textarea" placeholder="Adicionar nota interna (não é enviada ao cliente)..." value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 44 }} />
        <button className="btn primary" onClick={add} disabled={!note.trim()}>Salvar nota</button>
      </div>
      <div className="row wrap">
        <span className="small muted">Mostrar:</span>
        {[['', 'Tudo'], ['note', 'Notas'], ['whatsapp_in,whatsapp_out', 'WhatsApp'], ['stage_changed,opportunity_won,opportunity_lost,opportunity_created', 'Funil'], ['task_created,task_done,task_rescheduled', 'Atividades'], ['status_changed,owner_changed', 'Status/responsável']].map(([v, l]) => (
          <button key={v} className={`btn sm ${filter === v ? 'primary' : ''}`} onClick={() => setFilter(v)}>{l}</button>
        ))}
      </div>
      {q.isLoading && <Loading />}
      <div className="timeline">
        {rows.map((e: any) => (
          <div key={e.id} className="tl-item">
            <div className="tl-ico">{EVENT_ICONS[e.type] ?? '•'}</div>
            <div>
              <div className="tl-title"><EventText e={e} users={users} /></div>
              <div className="tl-meta">{fmtDateTime(e.created_at)} · {e.user_name ?? 'sistema'}</div>
            </div>
          </div>
        ))}
        {!q.isLoading && !rows.length && <div className="muted">Nenhum registro.</div>}
      </div>
      {q.hasNextPage && <button className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Carregar mais</button>}
    </div>
  );
}
