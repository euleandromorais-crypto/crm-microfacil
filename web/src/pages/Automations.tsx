import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, Tabs, useConfirm, useToast } from '../components/ui';
import { fmtDateTime, STATUS_LABELS, TASK_TYPES } from '../format';
import { usePipelines, useTags, useUsers } from '../hooks';

const OPS: Record<string, string> = { eq: 'é igual a', neq: 'é diferente de', in: 'está em (lista)', not_in: 'não está em (lista)', empty: 'está vazio', not_empty: 'está preenchido', gt: 'maior que', lt: 'menor que', contains: 'contém', not_contains: 'não contém' };
const ACTIONS: Record<string, string> = {
  assign_owner: 'Atribuir responsável', create_task: 'Criar tarefa', notify: 'Enviar notificação interna', set_lead_status: 'Alterar status do lead',
  add_tag: 'Adicionar etiqueta', remove_tag: 'Remover etiqueta', move_opportunity: 'Mover oportunidade de etapa', create_opportunity: 'Criar oportunidade',
  flag_reactivation: 'Sinalizar reativação', send_whatsapp_template: 'Enviar modelo de WhatsApp (somente com consentimento)',
};
const TIME_TRIGGERS: Record<string, 'minutes' | 'days'> = { 'lead.no_contact': 'minutes', 'lead.no_interaction': 'days', 'opportunity.stale': 'days', 'conversation.awaiting': 'minutes', 'task.overdue': 'minutes' };

export default function Automations() {
  const [tab, setTab] = useState<'rules' | 'runs'>('rules');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<any>(null);
  const { data: meta } = useQuery({ queryKey: ['automation-meta'], queryFn: () => api.get('/api/automations/meta') });
  const { data: rules, isLoading, error, refetch } = useQuery({ queryKey: ['automations'], queryFn: () => api.get('/api/automations') });
  const { data: runs } = useQuery({ queryKey: ['automation-runs'], queryFn: () => api.get('/api/automations/runs'), enabled: tab === 'runs' });
  const triggers = { ...(meta?.eventTriggers ?? {}), ...(meta?.scheduleTriggers ?? {}) };
  const toggle = async (r: any) => {
    await api.post(`/api/automations/${r.id}/toggle`);
    qc.invalidateQueries({ queryKey: ['automations'] });
    toast(r.active ? 'Automação desativada' : 'Automação ativada');
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: 'Excluir automação?', text: r.name, danger: true, confirm: 'Excluir' }))) return;
    await api.del(`/api/automations/${r.id}`);
    qc.invalidateQueries({ queryKey: ['automations'] });
  };
  return (
    <div>
      <div className="page-head">
        <h1>Automações comerciais</h1>
        <span className="sub">Gatilho → condições → ações. Executadas em segundo plano, com novas tentativas e histórico.</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => setEdit({ name: '', trigger: 'lead.created', trigger_config: {}, conditions: [], actions: [], delay_minutes: 0, active: true })}>+ Nova automação</button>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ value: 'rules', label: 'Regras' }, { value: 'runs', label: 'Histórico de execuções' }]} />
      {tab === 'rules' && (
        <div className="card">
          {isLoading && <Loading />}
          {error && <ErrorBox error={error} retry={refetch} />}
          {rules && !rules.length && <Empty icon="⚙️" text="Nenhuma automação configurada." />}
          {rules?.map((r: any) => (
            <div key={r.id} className="task-row">
              <label className="check" title={r.active ? 'Ativa' : 'Inativa'}><input type="checkbox" checked={r.active} onChange={() => toggle(r)} /></label>
              <div style={{ cursor: 'pointer' }} onClick={() => setEdit(r)}>
                <div className="cell-main">{r.name} {!r.active && <Badge>inativa</Badge>} {r.fail_count > 0 && <Badge color="red">{r.fail_count} falha(s)</Badge>}</div>
                <div className="cell-sub">
                  Quando: <b>{triggers[r.trigger] ?? r.trigger}</b>
                  {r.trigger_config?.minutes ? ` (${r.trigger_config.minutes} min)` : ''}{r.trigger_config?.days ? ` (${r.trigger_config.days} dias)` : ''}
                  {r.conditions.length ? ` · ${r.conditions.length} condição(ões)` : ''} · Ações: {r.actions.map((a: any) => ACTIONS[a.type]).join(', ')}
                  {r.delay_minutes ? ` · atraso ${r.delay_minutes} min` : ''}
                </div>
                <div className="cell-sub">{r.run_count} execuções · última {r.last_run_at ? fmtDateTime(r.last_run_at) : 'nunca'}</div>
              </div>
              <div className="btn-row"><button className="btn sm" onClick={() => setEdit(r)}>Editar</button><button className="btn sm ghost" onClick={() => remove(r)}>Excluir</button></div>
            </div>
          ))}
        </div>
      )}
      {tab === 'runs' && (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>Quando</th><th>Regra</th><th>Registro</th><th>Situação</th><th>Resultado</th></tr></thead>
            <tbody>
              {runs?.map((r: any) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtDateTime(r.created_at)}</td>
                  <td>{r.rule_name}</td>
                  <td>{r.entity_type} #{r.entity_id}</td>
                  <td><Badge color={r.status === 'success' ? 'green' : r.status === 'partial' ? 'amber' : 'red'}>{r.status === 'success' ? 'Sucesso' : r.status === 'partial' ? 'Parcial' : 'Falhou'}</Badge></td>
                  <td className="small">{(r.result ?? []).map((x: any, i: number) => <div key={i}>{x.ok ? '✓' : '✕'} {ACTIONS[x.action] ?? x.action}: {x.result ?? x.error}</div>)}</td>
                </tr>
              ))}
              {runs && !runs.length && <tr><td colSpan={5} className="muted">Nenhuma execução registrada.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && meta && <RuleEditor rule={edit} meta={meta} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RuleEditor({ rule, meta, onClose }: { rule: any; meta: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: users } = useUsers();
  const { data: tags } = useTags();
  const { data: pipelines } = usePipelines();
  const [r, setR] = useState<any>(JSON.parse(JSON.stringify(rule)));
  const [testLead, setTestLead] = useState('');
  const set = (k: string, v: any) => setR((x: any) => ({ ...x, [k]: v }));
  const timeUnit = TIME_TRIGGERS[r.trigger];
  const allStages = (pipelines ?? []).flatMap((p) => p.stages.filter((s: any) => !s.archived).map((s: any) => ({ ...s, label: `${p.name} › ${s.name}` })));
  const save = async () => {
    try {
      const body = { name: r.name, description: r.description ?? null, trigger: r.trigger, trigger_config: r.trigger_config ?? {}, conditions: r.conditions, actions: r.actions, delay_minutes: Number(r.delay_minutes) || 0, active: r.active };
      if (r.id) await api.put(`/api/automations/${r.id}`, body);
      else await api.post('/api/automations', body);
      toast('Automação salva');
      qc.invalidateQueries({ queryKey: ['automations'] });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const test = async () => {
    try {
      const res = await api.post(`/api/automations/${r.id}/test`, { lead_id: Number(testLead) });
      toast(res.status === 'skipped' ? 'Condições não atendidas para este lead (nada executado)' : `Execução: ${res.status}`, res.status === 'failed' ? 'error' : 'success');
      qc.invalidateQueries({ queryKey: ['automation-runs'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const setAction = (i: number, patch: any) => set('actions', r.actions.map((a: any, j: number) => (j === i ? { ...a, ...patch } : a)));
  const setCond = (i: number, patch: any) => set('conditions', r.conditions.map((c: any, j: number) => (j === i ? { ...c, ...patch } : c)));
  const valueInput = (c: any, i: number) => {
    if (['empty', 'not_empty'].includes(c.op)) return null;
    if (c.field === 'lead.status' || (c.field.startsWith('event.') && r.trigger === 'lead.status_changed')) {
      return <input className="input" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={Object.keys(STATUS_LABELS).join(',')} title={Object.entries(STATUS_LABELS).map(([k, v]) => `${k} = ${v}`).join('\n')} />;
    }
    if (c.field === 'lead.owner_id') return <select className="select" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })}><option value="">—</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
    if (c.field === 'lead.tags') return <select className="select" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })}><option value="">—</option>{tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>;
    if (c.field === 'opportunity.stage_id' || (c.field.startsWith('event.') && r.trigger === 'opportunity.stage_changed')) return <select className="select" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })}><option value="">—</option>{allStages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>;
    return <input className="input" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} />;
  };
  return (
    <Modal size="lg" title={r.id ? 'Editar automação' : 'Nova automação'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Nome *" className="full"><input className="input" value={r.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Descrição" className="full"><input className="input" value={r.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Gatilho (quando)">
            <select className="select" value={r.trigger} onChange={(e) => set('trigger', e.target.value)}>
              <optgroup label="Eventos">{Object.entries(meta.eventTriggers).map(([k, v]: any) => <option key={k} value={k}>{v}</option>)}</optgroup>
              <optgroup label="Tempo (verificado a cada 5 min)">{Object.entries(meta.scheduleTriggers).map(([k, v]: any) => <option key={k} value={k}>{v}</option>)}</optgroup>
            </select>
          </Field>
          {timeUnit ? (
            <Field label={timeUnit === 'days' ? 'Dias' : 'Minutos'}><input className="input" type="number" min={1} value={r.trigger_config?.[timeUnit] ?? ''} onChange={(e) => set('trigger_config', { ...r.trigger_config, [timeUnit]: Number(e.target.value) || undefined })} /></Field>
          ) : (
            <Field label="Atraso antes de executar (min)" hint="0 = imediatamente"><input className="input" type="number" min={0} value={r.delay_minutes} onChange={(e) => set('delay_minutes', e.target.value)} /></Field>
          )}
          <label className="check full"><input type="checkbox" checked={r.active} onChange={(e) => set('active', e.target.checked)} /> Ativa</label>
        </div>
        <div className="card card-pad">
          <div className="row"><h3 className="spacer">Condições (todas devem ser verdadeiras)</h3><button className="btn sm" onClick={() => set('conditions', [...r.conditions, { field: 'lead.source', op: 'eq', value: '' }])}>+ Condição</button></div>
          {!r.conditions.length && <div className="muted small">Sem condições: executa sempre que o gatilho ocorrer.</div>}
          {r.conditions.map((c: any, i: number) => (
            <div key={i} className="row" style={{ marginTop: 8 }}>
              <select className="select" value={c.field} onChange={(e) => setCond(i, { field: e.target.value, value: '' })}>{Object.entries(meta.conditionFields).map(([k, v]: any) => <option key={k} value={k}>{v}</option>)}</select>
              <select className="select" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              {valueInput(c, i)}
              <button className="btn icon" onClick={() => set('conditions', r.conditions.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <div className="card card-pad">
          <div className="row"><h3 className="spacer">Ações (em ordem)</h3>
            <select className="select sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && set('actions', [...r.actions, defaultAction(e.target.value)])}>
              <option value="">+ Adicionar ação...</option>
              {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          {!r.actions.length && <div className="muted small">Adicione ao menos uma ação.</div>}
          {r.actions.map((a: any, i: number) => (
            <div key={i} className="card card-pad" style={{ marginTop: 8, padding: 10 }}>
              <div className="row"><b className="spacer">{i + 1}. {ACTIONS[a.type]}</b><button className="btn sm ghost" onClick={() => set('actions', r.actions.filter((_: any, j: number) => j !== i))}>Remover</button></div>
              <div className="form-grid" style={{ marginTop: 6 }}>
                {a.type === 'assign_owner' && (
                  <>
                    <Field label="Modo"><select className="select" value={a.mode} onChange={(e) => setAction(i, { mode: e.target.value })}><option value="distribution">Regra de distribuição</option><option value="user">Usuário específico</option></select></Field>
                    {a.mode === 'user' && <Field label="Usuário"><select className="select" value={a.user_id ?? ''} onChange={(e) => setAction(i, { user_id: Number(e.target.value) })}><option value="">—</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
                  </>
                )}
                {a.type === 'create_task' && (
                  <>
                    <Field label="Tipo"><select className="select" value={a.task_type} onChange={(e) => setAction(i, { task_type: e.target.value })}>{Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                    <Field label="Prazo (min após o gatilho)"><input className="input" type="number" min={0} value={a.due_in_minutes} onChange={(e) => setAction(i, { due_in_minutes: Number(e.target.value) })} /></Field>
                    <Field label="Título" className="full" hint="Variáveis: {{lead.name}}, {{course.name}}, {{owner.name}}"><input className="input" value={a.title} onChange={(e) => setAction(i, { title: e.target.value })} /></Field>
                    <Field label="Responsável"><select className="select" value={a.assignee} onChange={(e) => setAction(i, { assignee: e.target.value })}><option value="owner">Responsável do lead</option><option value="user">Usuário específico</option></select></Field>
                    {a.assignee === 'user' && <Field label="Usuário"><select className="select" value={a.user_id ?? ''} onChange={(e) => setAction(i, { user_id: Number(e.target.value) })}><option value="">—</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
                  </>
                )}
                {a.type === 'notify' && (
                  <>
                    <Field label="Para"><select className="select" value={a.to} onChange={(e) => setAction(i, { to: e.target.value })}><option value="owner">Responsável</option><option value="managers">Gestores</option><option value="user">Usuário específico</option></select></Field>
                    {a.to === 'user' && <Field label="Usuário"><select className="select" value={a.user_id ?? ''} onChange={(e) => setAction(i, { user_id: Number(e.target.value) })}><option value="">—</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
                    <Field label="Título" className="full"><input className="input" value={a.title} onChange={(e) => setAction(i, { title: e.target.value })} /></Field>
                    <Field label="Mensagem" className="full"><input className="input" value={a.body ?? ''} onChange={(e) => setAction(i, { body: e.target.value })} /></Field>
                  </>
                )}
                {a.type === 'set_lead_status' && <Field label="Novo status"><select className="select" value={a.status} onChange={(e) => setAction(i, { status: e.target.value })}>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
                {(a.type === 'add_tag' || a.type === 'remove_tag') && <Field label="Etiqueta"><select className="select" value={a.tag_id ?? ''} onChange={(e) => setAction(i, { tag_id: Number(e.target.value) })}><option value="">—</option>{tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
                {a.type === 'move_opportunity' && <Field label="Etapa" className="full"><select className="select" value={a.stage_id ?? ''} onChange={(e) => setAction(i, { stage_id: Number(e.target.value) })}><option value="">—</option>{allStages.filter((s) => s.kind === 'open').map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>}
                {a.type === 'create_opportunity' && <Field label="Funil"><select className="select" value={a.pipeline_id ?? ''} onChange={(e) => setAction(i, { pipeline_id: e.target.value ? Number(e.target.value) : null })}><option value="">Padrão</option>{pipelines?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
                {a.type === 'send_whatsapp_template' && (
                  <>
                    <div className="full alert warn small">Enviado apenas para leads com consentimento de WhatsApp registrado, uma vez por evento, sem disparos em massa — conforme as políticas da Meta. Use somente modelos aprovados.</div>
                    <Field label="Nome do modelo"><input className="input" value={a.template_name} onChange={(e) => setAction(i, { template_name: e.target.value })} /></Field>
                    <Field label="Idioma"><input className="input" value={a.language} onChange={(e) => setAction(i, { language: e.target.value })} /></Field>
                    <Field label="Variáveis do corpo (uma por linha)" className="full" hint="Ex.: {{lead.name}}"><textarea className="textarea" value={(a.params ?? []).join('\n')} onChange={(e) => setAction(i, { params: e.target.value.split('\n').filter((x) => x !== '') })} /></Field>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        {r.id && (
          <div className="row">
            <input className="input" style={{ maxWidth: 200 }} placeholder="ID do lead para teste" value={testLead} onChange={(e) => setTestLead(e.target.value)} />
            <button className="btn" disabled={!testLead} onClick={test}>Executar teste agora</button>
            <span className="small muted">Executa as ações de verdade sobre o lead informado.</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function defaultAction(type: string) {
  switch (type) {
    case 'assign_owner': return { type, mode: 'distribution' };
    case 'create_task': return { type, task_type: 'followup', title: 'Acompanhamento: {{lead.name}}', due_in_minutes: 60, assignee: 'owner' };
    case 'notify': return { type, to: 'owner', title: 'Atenção: {{lead.name}}', body: '' };
    case 'set_lead_status': return { type, status: 'in_progress' };
    case 'send_whatsapp_template': return { type, template_name: '', language: 'pt_BR', params: ['{{lead.name}}'] };
    default: return { type };
  }
}
