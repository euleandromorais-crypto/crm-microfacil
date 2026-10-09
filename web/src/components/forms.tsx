import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { addDays, duration, fmtDateTime, isoToLocal, localDate, localToIso, money, STATUS_LABELS, TASK_TYPES } from '../format';
import { useCampaigns, useCourses, useCustomFields, useLostReasons, usePipelines, useSettings, useTags, useUsers } from '../hooks';
import { Badge, Drawer, Field, Loading, Modal, useConfirm, useDebounced, useToast } from './ui';

export function UserSelect({ value, onChange, placeholder = '— Sem responsável —', allowEmpty = true, className }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; allowEmpty?: boolean; className?: string }) {
  const { data: users } = useUsers();
  return (
    <select className={`select ${className ?? ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {users?.filter((u) => u.active || u.id === value).map((u) => (
        <option key={u.id} value={u.id}>{u.name}</option>
      ))}
    </select>
  );
}

export function CourseSelect({ value, onChange, className }: { value: number | null | undefined; onChange: (v: number | null) => void; className?: string }) {
  const { data } = useCourses();
  return (
    <select className={`select ${className ?? ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">— Nenhum —</option>
      {data?.filter((c) => c.active || c.id === value).map((c) => (
        <option key={c.id} value={c.id}>{c.name}{!c.active ? ' (inativo)' : ''}</option>
      ))}
    </select>
  );
}

export function TagPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { data: tags } = useTags();
  return (
    <div className="row wrap">
      {tags?.map((t) => {
        const on = value.includes(t.id);
        return (
          <button
            type="button"
            key={t.id}
            className="tag"
            style={{ background: on ? t.color : '#e2e8f0', color: on ? '#fff' : '#475569', border: 'none', cursor: 'pointer' }}
            onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}
          >
            {on ? '✓ ' : ''}{t.name}
          </button>
        );
      })}
      {!tags?.length && <span className="muted small">Nenhuma etiqueta cadastrada.</span>}
    </div>
  );
}

export function TagList({ ids }: { ids?: number[] }) {
  const { data: tags } = useTags();
  if (!ids?.length) return null;
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {ids.map((id) => {
        const t = tags?.find((x) => x.id === id);
        return t ? <span key={id} className="tag" style={{ background: t.color }}>{t.name}</span> : null;
      })}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { new: 'blue', attempting: 'amber', in_progress: 'indigo', qualified: 'violet', customer: 'green', lost: 'red', unqualified: 'gray' };
  return <Badge color={colors[status]}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function CustomFieldInput({ def, value, onChange }: { def: any; value: any; onChange: (v: any) => void }) {
  switch (def.type) {
    case 'textarea':
      return <textarea className="textarea" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input className="input" type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input className="input" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'boolean':
      return (
        <select className="select" value={value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
          <option value="">—</option>
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </select>
      );
    case 'select':
      return (
        <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(def.options ?? []).map((o: string) => <option key={o}>{o}</option>)}
        </select>
      );
    default:
      return <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

// ---------------------------------------------------------------- Lead
export function LeadFormModal({ lead, onClose, onSaved }: { lead?: any; onClose: () => void; onSaved?: (lead: any) => void }) {
  const { isManager } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: campaigns } = useCampaigns();
  const { data: fields } = useCustomFields();
  const editing = !!lead?.id;
  const [f, setF] = useState<any>(() => ({
    name: lead?.name ?? '', phone: lead?.phone ? `+${lead.phone}` : '', email: lead?.email ?? '', course_id: lead?.course_id ?? null, source: lead?.source ?? '',
    campaign_id: lead?.campaign_id ?? null, owner_id: lead?.owner_id ?? null, city: lead?.city ?? '', state: lead?.state ?? '', document: lead?.document ?? '',
    birth_date: lead?.birth_date ?? '', notes: lead?.notes ?? '', utm_source: lead?.utm_source ?? '', utm_medium: lead?.utm_medium ?? '', utm_campaign: lead?.utm_campaign ?? '',
    utm_term: lead?.utm_term ?? '', utm_content: lead?.utm_content ?? '', consent_whatsapp: lead?.consent_whatsapp ?? false, tags: lead?.tag_ids ?? [], custom: lead?.custom ?? {},
    create_opportunity: true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [showUtm, setShowUtm] = useState(!!(lead?.utm_source || lead?.utm_campaign));
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const dPhone = useDebounced(f.phone, 500);
  const dEmail = useDebounced(f.email, 500);
  const { data: dup } = useQuery({
    queryKey: ['dup', dPhone, dEmail, lead?.id],
    queryFn: () => api.get('/api/leads/check-duplicate', { phone: dPhone, email: dEmail, exclude: lead?.id }),
    enabled: !!(dPhone.replace(/\D/g, '').length >= 10 || /@.+\./.test(dEmail)),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (!f.phone && !f.email) return setErrors({ phone: 'Informe telefone ou e-mail' });
    setBusy(true);
    try {
      const body = { ...f };
      if (!isManager && !editing) delete body.owner_id;
      if (editing) delete body.create_opportunity;
      const saved = editing ? await api.patch(`/api/leads/${lead.id}`, body) : await api.post('/api/leads', body);
      toast(editing ? 'Lead atualizado' : 'Lead cadastrado');
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      onSaved?.(saved);
      onClose();
    } catch (err: any) {
      setErrors(err.details?.fields ?? {});
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="lg" title={editing ? 'Editar lead' : 'Novo lead'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" form="lead-form" disabled={busy}>{busy ? 'Salvando...' : 'Salvar'}</button>
      </>
    }>
      <form id="lead-form" onSubmit={submit} className="stack">
        {dup?.duplicate && (
          <div className="alert warn">
            Já existe um lead com este contato: <Link to={`/leads/${dup.duplicate.id}`} onClick={onClose}><b>{dup.duplicate.name}</b></Link>
            {dup.duplicate.owner_name ? ` (responsável: ${dup.duplicate.owner_name})` : ''}. Evite cadastros duplicados.
          </div>
        )}
        <div className="form-grid">
          <Field label="Nome *" className="full" error={errors.name}>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
          </Field>
          <Field label="Telefone / WhatsApp" error={errors.phone} hint="Com DDD. Ex.: (11) 99999-8888">
            <input className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Curso de interesse">
            <CourseSelect value={f.course_id} onChange={(v) => set('course_id', v)} />
          </Field>
          <Field label="Origem">
            <input className="input" list="sources" value={f.source} onChange={(e) => set('source', e.target.value)} />
            <datalist id="sources">{settings?.general?.sources?.map((s: string) => <option key={s} value={s} />)}</datalist>
          </Field>
          <Field label="Campanha">
            <select className="select" value={f.campaign_id ?? ''} onChange={(e) => set('campaign_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">— Nenhuma —</option>
              {campaigns?.filter((c) => c.active || c.id === f.campaign_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          {isManager && (
            <Field label="Responsável" hint={!editing ? 'Vazio = distribuição automática' : undefined}>
              <UserSelect value={f.owner_id} onChange={(v) => set('owner_id', v)} placeholder={editing ? '— Sem responsável —' : '— Distribuição automática —'} />
            </Field>
          )}
          <Field label="Cidade"><input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="UF"><input className="input" value={f.state} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase())} /></Field>
          <Field label="CPF / documento"><input className="input" value={f.document} onChange={(e) => set('document', e.target.value)} /></Field>
          <Field label="Data de nascimento"><input className="input" type="date" value={f.birth_date ?? ''} onChange={(e) => set('birth_date', e.target.value)} /></Field>
          {fields?.filter((d) => d.active).map((d) => (
            <Field key={d.id} label={`${d.label}${d.required ? ' *' : ''}`}>
              <CustomFieldInput def={d} value={f.custom?.[d.key]} onChange={(v) => set('custom', { ...f.custom, [d.key]: v })} />
            </Field>
          ))}
          <Field label="Etiquetas" className="full"><TagPicker value={f.tags} onChange={(v) => set('tags', v)} /></Field>
          <Field label="Observações internas" className="full"><textarea className="textarea" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <label className="check full"><input type="checkbox" checked={f.consent_whatsapp} onChange={(e) => set('consent_whatsapp', e.target.checked)} /> Lead autorizou contato pelo WhatsApp (consentimento — LGPD)</label>
          {!editing && <label className="check full"><input type="checkbox" checked={f.create_opportunity} onChange={(e) => set('create_opportunity', e.target.checked)} /> Criar oportunidade no funil padrão</label>}
        </div>
        <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowUtm(!showUtm)}>{showUtm ? '▾' : '▸'} Parâmetros UTM</button>
        {showUtm && (
          <div className="form-grid">
            {['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].map((k) => (
              <Field key={k} label={k}><input className="input" value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Tarefas
export function TaskFormModal({ task, defaults, onClose, onSaved }: { task?: any; defaults?: { lead_id?: number; opportunity_id?: number; title?: string; type?: string; leadName?: string }; onClose: () => void; onSaved?: () => void }) {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editing = !!task?.id;
  const initial = task?.due_at ? isoToLocal(task.due_at) : { date: localDate(), time: nextSlot() };
  const [f, setF] = useState<any>({
    type: task?.type ?? defaults?.type ?? 'followup',
    title: task?.title ?? defaults?.title ?? '',
    description: task?.description ?? '',
    date: initial.date,
    time: initial.time,
    duration_minutes: task?.duration_minutes ?? 30,
    remind_minutes_before: task?.remind_minutes_before ?? 15,
    assignee_id: task?.assignee_id ?? user!.id,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: any = {
        type: f.type, title: f.title, description: f.description || null, due_at: localToIso(f.date, f.time),
        duration_minutes: Number(f.duration_minutes), remind_minutes_before: Number(f.remind_minutes_before), assignee_id: f.assignee_id,
      };
      if (editing) await api.patch(`/api/tasks/${task.id}`, body);
      else await api.post('/api/tasks', { ...body, lead_id: defaults?.lead_id ?? null, opportunity_id: defaults?.opportunity_id ?? null });
      toast(editing ? 'Atividade atualizada' : 'Atividade agendada');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-summary'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      onSaved?.();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const quick = (days: number, time?: string) => {
    set('date', addDays(localDate(), days));
    if (time) set('time', time);
  };
  return (
    <Modal title={editing ? 'Editar atividade' : `Nova atividade${defaults?.leadName ? ` — ${defaults.leadName}` : ''}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" form="task-form" disabled={busy}>Salvar</button>
      </>
    }>
      <form id="task-form" className="form-grid" onSubmit={submit}>
        <Field label="Tipo">
          <select className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>
            {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Responsável">
          {isManager ? <UserSelect value={f.assignee_id} onChange={(v) => set('assignee_id', v)} allowEmpty={false} /> : <input className="input" value={user!.name} disabled />}
        </Field>
        <Field label="Título *" className="full">
          <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} required autoFocus placeholder="Ex.: Ligar para apresentar proposta" />
        </Field>
        <Field label="Data"><input className="input" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required /></Field>
        <Field label="Horário"><input className="input" type="time" value={f.time} onChange={(e) => set('time', e.target.value)} required /></Field>
        <div className="full row wrap">
          <span className="small muted">Atalhos:</span>
          <button type="button" className="btn sm" onClick={() => { set('date', localDate()); set('time', nextSlot(60)); }}>Em 1h</button>
          <button type="button" className="btn sm" onClick={() => quick(1, '09:00')}>Amanhã 9h</button>
          <button type="button" className="btn sm" onClick={() => quick(2, '09:00')}>Em 2 dias</button>
          <button type="button" className="btn sm" onClick={() => quick(7, '09:00')}>Próxima semana</button>
        </div>
        <Field label="Duração (min)"><input className="input" type="number" min={0} value={f.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)} /></Field>
        <Field label="Lembrete">
          <select className="select" value={f.remind_minutes_before} onChange={(e) => set('remind_minutes_before', e.target.value)}>
            {[0, 5, 10, 15, 30, 60, 120, 1440].map((m) => <option key={m} value={m}>{m === 0 ? 'Na hora' : m < 60 ? `${m} min antes` : m === 1440 ? '1 dia antes' : `${m / 60}h antes`}</option>)}
          </select>
        </Field>
        <Field label="Descrição" className="full"><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

function nextSlot(addMin = 30) {
  const now = new Date(Date.now() + addMin * 60_000);
  const { time } = isoToLocal(now.toISOString());
  const [h, m] = time.split(':').map(Number);
  const rounded = Math.ceil(m / 15) * 15;
  const hh = rounded === 60 ? (h + 1) % 24 : h;
  return `${String(hh).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

export function CompleteTaskModal({ task, onClose }: { task: any; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState(false);
  const [n, setN] = useState({ title: `Retorno: ${task.lead_name ?? task.title}`, date: addDays(localDate(), 1), time: '09:00', type: 'followup' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/api/tasks/${task.id}/complete`, { outcome: outcome || null, next: next ? { title: n.title, type: n.type, due_at: localToIso(n.date, n.time) } : null });
      toast(next ? 'Atividade concluída e próximo retorno agendado' : 'Atividade concluída');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['task-summary'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Concluir atividade" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn success" form="complete-form">Concluir</button></>}>
      <form id="complete-form" className="stack" onSubmit={submit}>
        <div><b>{task.title}</b>{task.lead_name && <div className="muted small">{task.lead_name}</div>}</div>
        <Field label="Resultado / anotação"><textarea className="textarea" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Ex.: Atendeu, pediu para retornar amanhã com valores" autoFocus /></Field>
        {task.lead_id && <label className="check"><input type="checkbox" checked={next} onChange={(e) => setNext(e.target.checked)} /> Agendar próximo acompanhamento</label>}
        {next && (
          <div className="form-grid">
            <Field label="Título" className="full"><input className="input" value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} required /></Field>
            <Field label="Tipo"><select className="select" value={n.type} onChange={(e) => setN({ ...n, type: e.target.value })}>{Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Data"><input className="input" type="date" value={n.date} onChange={(e) => setN({ ...n, date: e.target.value })} /></Field>
            <Field label="Horário"><input className="input" type="time" value={n.time} onChange={(e) => setN({ ...n, time: e.target.value })} /></Field>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Oportunidades
export function NewOpportunityModal({ leadId, leadName, onClose, onSaved }: { leadId: number; leadName?: string; onClose: () => void; onSaved?: (o: any) => void }) {
  const { isManager } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: pipelines } = usePipelines();
  const { data: courses } = useCourses();
  const active = pipelines?.filter((p) => p.active) ?? [];
  const [f, setF] = useState<any>({ pipeline_id: null, stage_id: null, course_id: null, value: '', expected_close_date: '', title: '', owner_id: undefined });
  useEffect(() => {
    if (active.length && !f.pipeline_id) setF((x: any) => ({ ...x, pipeline_id: (active.find((p) => p.is_default) ?? active[0]).id }));
  }, [active.length]); // eslint-disable-line
  const stages = active.find((p) => p.id === f.pipeline_id)?.stages.filter((s: any) => s.kind === 'open' && !s.archived) ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body: any = { lead_id: leadId, pipeline_id: f.pipeline_id, stage_id: f.stage_id || stages[0]?.id, course_id: f.course_id, value: f.value === '' ? null : Number(f.value), expected_close_date: f.expected_close_date || null, title: f.title || null };
      if (isManager && f.owner_id !== undefined) body.owner_id = f.owner_id;
      const o = await api.post('/api/opportunities', body);
      toast('Oportunidade criada');
      qc.invalidateQueries({ queryKey: ['lead'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      onSaved?.(o);
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title={`Nova oportunidade${leadName ? ` — ${leadName}` : ''}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="opp-form">Criar</button></>}>
      <form id="opp-form" className="form-grid" onSubmit={submit}>
        <Field label="Funil">
          <select className="select" value={f.pipeline_id ?? ''} onChange={(e) => setF({ ...f, pipeline_id: Number(e.target.value), stage_id: null })}>
            {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Etapa">
          <select className="select" value={f.stage_id ?? ''} onChange={(e) => setF({ ...f, stage_id: Number(e.target.value) })}>
            {stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Curso / formação">
          <CourseSelect value={f.course_id} onChange={(v) => {
            const c = courses?.find((x) => x.id === v);
            setF({ ...f, course_id: v, value: f.value === '' && c ? (c.promo_price ?? c.price ?? '') : f.value });
          }} />
        </Field>
        <Field label="Valor previsto (R$)"><input className="input" type="number" step="0.01" min={0} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
        <Field label="Previsão de fechamento"><input className="input" type="date" value={f.expected_close_date} onChange={(e) => setF({ ...f, expected_close_date: e.target.value })} /></Field>
        {isManager && <Field label="Responsável"><UserSelect value={f.owner_id ?? null} onChange={(v) => setF({ ...f, owner_id: v })} placeholder="— Responsável do lead —" /></Field>}
        <Field label="Título (opcional)" className="full"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Gerado automaticamente a partir do curso" /></Field>
      </form>
    </Modal>
  );
}

export function WinModal({ opp, stageId, onClose, onDone }: { opp: any; stageId?: number; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<string>(String(opp.sale_value ?? opp.value ?? ''));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (stageId) await api.post(`/api/opportunities/${opp.id}/move`, { stage_id: stageId, sale_value: Number(value) });
      else await api.post(`/api/opportunities/${opp.id}/win`, { sale_value: Number(value) });
      toast('🎉 Matrícula registrada!');
      onDone?.();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Registrar matrícula (venda ganha)" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn success" form="win-form">Confirmar matrícula</button></>}>
      <form id="win-form" className="stack" onSubmit={submit}>
        <div><b>{opp.title}</b></div>
        <Field label="Valor da venda (R$) *" hint={opp.value ? `Valor previsto: ${money(opp.value)}` : undefined}>
          <input className="input" type="number" step="0.01" min={0} value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

export function LoseModal({ opp, stageId, onClose, onDone }: { opp: any; stageId?: number; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const { data: reasons } = useLostReasons();
  const [reason, setReason] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (stageId) await api.post(`/api/opportunities/${opp.id}/move`, { stage_id: stageId, lost_reason_id: reason, lost_note: note || null });
      else await api.post(`/api/opportunities/${opp.id}/lose`, { lost_reason_id: reason, lost_note: note || null });
      toast('Oportunidade marcada como perdida');
      onDone?.();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Marcar como perdida" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn danger" form="lose-form" disabled={!reason}>Confirmar perda</button></>}>
      <form id="lose-form" className="stack" onSubmit={submit}>
        <div><b>{opp.title}</b></div>
        <Field label="Motivo da perda *">
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value ? Number(e.target.value) : '')} required autoFocus>
            <option value="">Selecione...</option>
            {reasons?.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Observação"><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

/** Painel lateral com detalhes e ações da oportunidade */
export function OpportunityDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { isManager } = useAuth();
  const { data: pipelines } = usePipelines();
  const { data: campaigns } = useCampaigns();
  const { data: opp, isLoading, refetch } = useQuery({ queryKey: ['opportunity', id], queryFn: () => api.get(`/api/opportunities/${id}`) });
  const [edit, setEdit] = useState<any>(null);
  const [modal, setModal] = useState<ReactNode>(null);
  const stages = useMemo(() => pipelines?.find((p) => p.id === opp?.pipeline_id)?.stages.filter((s: any) => !s.archived) ?? [], [pipelines, opp]);
  const refresh = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['board'] });
    qc.invalidateQueries({ queryKey: ['lead'] });
  };
  if (isLoading || !opp) return <Drawer title="Oportunidade" onClose={onClose}><Loading /></Drawer>;
  const move = async (stageId: number) => {
    const st = stages.find((s: any) => s.id === stageId);
    if (st?.kind === 'won') return setModal(<WinModal opp={opp} stageId={stageId} onClose={() => setModal(null)} onDone={refresh} />);
    if (st?.kind === 'lost') return setModal(<LoseModal opp={opp} stageId={stageId} onClose={() => setModal(null)} onDone={refresh} />);
    try {
      await api.post(`/api/opportunities/${id}/move`, { stage_id: stageId });
      toast(`Movida para ${st?.name}`);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const save = async () => {
    try {
      await api.patch(`/api/opportunities/${id}`, {
        title: edit.title, value: edit.value === '' ? null : Number(edit.value), expected_close_date: edit.expected_close_date || null, course_id: edit.course_id,
        campaign_id: edit.campaign_id, ...(isManager ? { owner_id: edit.owner_id } : {}), ...(opp.status === 'won' ? { sale_value: edit.sale_value === '' ? null : Number(edit.sale_value) } : {}),
      });
      toast('Oportunidade atualizada');
      setEdit(null);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Excluir oportunidade?', text: 'O histórico de movimentações desta oportunidade será removido. Esta ação não pode ser desfeita.', danger: true, confirm: 'Excluir' }))) return;
    try {
      await api.del(`/api/opportunities/${id}`);
      toast('Oportunidade excluída');
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Drawer title={opp.title} onClose={onClose} footer={
      <>
        {isManager && <button className="btn ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={remove}>Excluir</button>}
        {opp.status === 'open' && <button className="btn danger" onClick={() => setModal(<LoseModal opp={opp} onClose={() => setModal(null)} onDone={refresh} />)}>Perdida</button>}
        {opp.status === 'open' && <button className="btn success" onClick={() => setModal(<WinModal opp={opp} onClose={() => setModal(null)} onDone={refresh} />)}>Matrícula realizada</button>}
      </>
    }>
      <div className="stack">
        <div className="row wrap">
          {opp.status === 'won' && <Badge color="green">Ganha em {fmtDateTime(opp.won_at)}</Badge>}
          {opp.status === 'lost' && <Badge color="red">Perdida — {opp.lost_reason ?? 'sem motivo'}</Badge>}
          {opp.is_stale && <Badge color="amber">Parada há {duration(opp.seconds_in_stage)}</Badge>}
          <Link to={`/leads/${opp.lead_id}`} onClick={onClose}>Abrir lead: {opp.lead_name} →</Link>
        </div>
        <Field label="Etapa">
          <select className="select" value={opp.stage_id} onChange={(e) => move(Number(e.target.value))}>
            {stages.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.kind === 'won' ? ' ✓' : s.kind === 'lost' ? ' ✕' : ''}</option>)}
          </select>
        </Field>
        {!edit ? (
          <div className="card card-pad">
            <div className="kv">
              <span className="k">Valor previsto</span><span>{money(opp.value)}</span>
              {opp.status === 'won' && (<><span className="k">Valor vendido</span><b>{money(opp.sale_value)}</b></>)}
              <span className="k">Curso</span><span>{opp.course_name ?? '—'}</span>
              <span className="k">Responsável</span><span>{opp.owner_name ?? '—'}</span>
              <span className="k">Previsão</span><span>{opp.expected_close_date ? opp.expected_close_date.split('-').reverse().join('/') : '—'}</span>
              <span className="k">Campanha</span><span>{opp.campaign_name ?? '—'}</span>
              <span className="k">Origem</span><span>{opp.source ?? '—'}</span>
              <span className="k">Na etapa há</span><span>{duration(opp.seconds_in_stage)}</span>
              <span className="k">Criada em</span><span>{fmtDateTime(opp.created_at)}</span>
              {opp.lost_note && (<><span className="k">Obs. perda</span><span>{opp.lost_note}</span></>)}
            </div>
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setEdit({ title: opp.title, value: opp.value ?? '', sale_value: opp.sale_value ?? '', expected_close_date: opp.expected_close_date ?? '', course_id: opp.course_id, campaign_id: opp.campaign_id, owner_id: opp.owner_id })}>Editar</button>
          </div>
        ) : (
          <div className="card card-pad form-grid">
            <Field label="Título" className="full"><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Valor previsto"><input className="input" type="number" step="0.01" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            {opp.status === 'won' && <Field label="Valor vendido"><input className="input" type="number" step="0.01" value={edit.sale_value} onChange={(e) => setEdit({ ...edit, sale_value: e.target.value })} /></Field>}
            <Field label="Previsão de fechamento"><input className="input" type="date" value={edit.expected_close_date} onChange={(e) => setEdit({ ...edit, expected_close_date: e.target.value })} /></Field>
            <Field label="Curso"><CourseSelect value={edit.course_id} onChange={(v) => setEdit({ ...edit, course_id: v })} /></Field>
            <Field label="Campanha">
              <select className="select" value={edit.campaign_id ?? ''} onChange={(e) => setEdit({ ...edit, campaign_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— Nenhuma —</option>
                {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            {isManager && <Field label="Responsável"><UserSelect value={edit.owner_id} onChange={(v) => setEdit({ ...edit, owner_id: v })} /></Field>}
            <div className="full btn-row"><button className="btn primary" onClick={save}>Salvar</button><button className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
          </div>
        )}
        <div>
          <div className="row"><h3 className="spacer">Atividades</h3><button className="btn sm" onClick={() => setModal(<TaskFormModal defaults={{ lead_id: opp.lead_id, opportunity_id: opp.id, leadName: opp.lead_name, title: `Acompanhamento: ${opp.lead_name}` }} onClose={() => setModal(null)} onSaved={refresh} />)}>+ Lembrete</button></div>
          {!opp.tasks.length && <div className="muted small">Nenhuma atividade vinculada.</div>}
          {opp.tasks.map((t: any) => (
            <div key={t.id} className="small" style={{ padding: '4px 0' }}>{t.status === 'done' ? '✅' : t.status === 'canceled' ? '⛔' : '⏳'} {t.title} — {fmtDateTime(t.due_at)} {t.assignee_name ? `· ${t.assignee_name}` : ''}</div>
          ))}
        </div>
        <div>
          <h3>Histórico de movimentações</h3>
          <div className="timeline">
            {opp.history.map((h: any) => (
              <div key={h.id} className="tl-item">
                <div className="tl-ico">➜</div>
                <div>
                  <div className="tl-title">{h.from_stage ? <>{h.from_stage} → <b>{h.to_stage}</b></> : <>Criada em <b>{h.to_stage}</b></>}</div>
                  <div className="tl-meta">{fmtDateTime(h.created_at)} {h.user_name ? `· ${h.user_name}` : '· sistema'}{h.seconds_in_prev ? ` · ficou ${duration(h.seconds_in_prev)} na etapa anterior` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {modal}
    </Drawer>
  );
}
