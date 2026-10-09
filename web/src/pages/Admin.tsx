import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { UserSelect } from '../components/forms';
import { Badge, CopyField, Empty, ErrorBox, Field, Loading, Modal, Pagination, useConfirm, useToast } from '../components/ui';
import { fmtDate, fmtDateTime, money, relative, ROLE_LABELS } from '../format';
import { useCampaigns, useCustomFields, useLostReasons, usePipelines, useQuickReplies, useSettings, useTags, useTeams, useUsers } from '../hooks';

const TABS: { key: string; label: string; admin?: boolean }[] = [
  { key: 'usuarios', label: 'Usuários' },
  { key: 'equipes', label: 'Equipes', admin: true },
  { key: 'distribuicao', label: 'Distribuição de leads' },
  { key: 'funis', label: 'Funis e etapas' },
  { key: 'campos', label: 'Campos personalizados', admin: true },
  { key: 'etiquetas', label: 'Etiquetas' },
  { key: 'perdas', label: 'Motivos de perda' },
  { key: 'respostas', label: 'Respostas rápidas' },
  { key: 'campanhas', label: 'Campanhas e investimento' },
  { key: 'geral', label: 'Configurações gerais', admin: true },
  { key: 'auditoria', label: 'Auditoria', admin: true },
];

function useMutate() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (fn: () => Promise<any>, msg: string, keys: string[]) => {
    try {
      const r = await fn();
      toast(r?.message ?? msg);
      keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      return r ?? true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    }
  };
}

export default function Admin() {
  const { tab = 'usuarios' } = useParams();
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const tabs = TABS.filter((t) => isAdmin || !t.admin);
  return (
    <div>
      <div className="page-head"><h1>{isAdmin ? 'Administração' : 'Configurações comerciais'}</h1></div>
      <div className="tabs">{tabs.map((t) => <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => nav(`/admin/${t.key}`)}>{t.label}</button>)}</div>
      {tab === 'usuarios' && <UsersTab />}
      {tab === 'equipes' && isAdmin && <TeamsTab />}
      {tab === 'distribuicao' && <DistributionTab />}
      {tab === 'funis' && <PipelinesTab />}
      {tab === 'campos' && isAdmin && <CustomFieldsTab />}
      {tab === 'etiquetas' && <TagsTab />}
      {tab === 'perdas' && <LostReasonsTab />}
      {tab === 'respostas' && <QuickRepliesTab />}
      {tab === 'campanhas' && <CampaignsTab />}
      {tab === 'geral' && isAdmin && <GeneralTab />}
      {tab === 'auditoria' && isAdmin && <AuditTab />}
    </div>
  );
}

// ---------------------------------------------------------------- usuários
function UsersTab() {
  const { isAdmin, user: me } = useAuth();
  const { data: users, isLoading } = useUsers();
  const { data: teams } = useTeams();
  const m = useMutate();
  const [modal, setModal] = useState<ReactNode>(null);
  if (isLoading) return <Loading />;
  return (
    <div className="card">
      <div className="card-head"><h2>Usuários e vendedores</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<UserForm teams={teams ?? []} onClose={() => setModal(null)} />)}>+ Novo usuário</button>}</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Nome</th><th>Perfil</th><th>Equipe</th><th>Recebe leads</th><th className="num">Leads abertos</th><th>Último acesso</th><th /></tr></thead>
          <tbody>
            {users?.map((u: any) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                <td><div className="cell-main">{u.name} {!u.active && <Badge color="red">inativo</Badge>}</div><div className="cell-sub">{u.email}</div></td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.team_name ?? '—'}</td>
                <td>
                  <label className="check"><input type="checkbox" checked={u.receives_leads} disabled={!u.active || (!isAdmin && u.role !== 'seller')} onChange={(e) => m(() => api.patch(`/api/users/${u.id}`, { receives_leads: e.target.checked }), 'Distribuição atualizada', ['users'])} />{u.max_open_leads ? <span className="small muted">máx. {u.max_open_leads}</span> : null}</label>
                </td>
                <td className="num">{u.open_leads}</td>
                <td className="small">{u.last_seen_at ? relative(u.last_seen_at) : u.last_login_at ? relative(u.last_login_at) : 'nunca'}</td>
                <td className="nowrap">
                  {isAdmin && <button className="btn sm" onClick={() => setModal(<UserForm user={u} teams={teams ?? []} onClose={() => setModal(null)} />)}>Editar</button>}
                  <button className="btn sm" onClick={() => setModal(<TransferModal user={u} onClose={() => setModal(null)} />)}>Transferir carteira</button>
                  {isAdmin && u.id !== me!.id && <button className="btn sm ghost" onClick={() => m(() => api.patch(`/api/users/${u.id}`, { active: !u.active }), u.active ? 'Usuário desativado (sessões encerradas)' : 'Usuário reativado', ['users'])}>{u.active ? 'Desativar' : 'Ativar'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal}
    </div>
  );
}

function UserForm({ user, teams, onClose }: { user?: any; teams: any[]; onClose: () => void }) {
  const m = useMutate();
  const [f, setF] = useState<any>({ name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? 'seller', team_id: user?.team_id ?? '', phone: user?.phone ?? '', receives_leads: user?.receives_leads ?? true, max_open_leads: user?.max_open_leads ?? '', password: '' });
  const [link, setLink] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...f, team_id: f.team_id || null, max_open_leads: f.max_open_leads || null, password: f.password || undefined };
    const r = await m(() => (user ? api.patch(`/api/users/${user.id}`, body) : api.post('/api/users', body)), 'Usuário salvo', ['users']);
    if (r) onClose();
  };
  const resetLink = async () => {
    const r = await m(() => api.post(`/api/users/${user.id}/reset-link`), 'Link gerado (válido por 24h)', []);
    if (r) setLink(r.link);
  };
  return (
    <Modal title={user ? 'Editar usuário' : 'Novo usuário'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="user-form">Salvar</button></>}>
      <form id="user-form" className="form-grid" onSubmit={submit}>
        <Field label="Nome *" className="full"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="E-mail *"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Telefone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Perfil">
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Equipe" hint="Gestores veem apenas os dados da própria equipe"><select className="select" value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value })}><option value="">—</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <label className="check"><input type="checkbox" checked={f.receives_leads} onChange={(e) => setF({ ...f, receives_leads: e.target.checked })} /> Recebe leads na distribuição</label>
        <Field label="Máx. leads em aberto" hint="Vazio = sem limite"><input className="input" type="number" min={1} value={f.max_open_leads} onChange={(e) => setF({ ...f, max_open_leads: e.target.value })} /></Field>
        <Field label={user ? 'Nova senha (opcional)' : 'Senha inicial *'} className="full" hint="Mínimo 8 caracteres, letras e números"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!user} /></Field>
        {user && (
          <div className="full">
            <button type="button" className="btn sm" onClick={resetLink}>Gerar link de redefinição de senha</button>
            {link && <div style={{ marginTop: 8 }}><CopyField value={link} /></div>}
          </div>
        )}
      </form>
    </Modal>
  );
}

function TransferModal({ user, onClose }: { user: any; onClose: () => void }) {
  const m = useMutate();
  const [to, setTo] = useState<number | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const submit = async () => {
    const r = await m(() => api.post(`/api/users/${user.id}/transfer`, { to_user_id: to, only_open: onlyOpen }), 'Carteira transferida', ['users', 'leads']);
    if (r) onClose();
  };
  return (
    <Modal title={`Transferir carteira de ${user.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={submit}>Transferir</button></>}>
      <div className="stack">
        <div className="small muted">Transfere leads, oportunidades abertas, atividades pendentes e conversas em andamento. Útil para férias ou desligamento.</div>
        <Field label="Para"><UserSelect value={to} onChange={setTo} placeholder="— Deixar sem responsável —" /></Field>
        <label className="check"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Somente leads em aberto (mantém clientes/perdidos com o vendedor original)</label>
      </div>
    </Modal>
  );
}

function TeamsTab() {
  const { data: teams } = useTeams();
  const m = useMutate();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  return (
    <div className="card card-pad stack" style={{ maxWidth: 600 }}>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); (await m(() => api.post('/api/teams', { name }), 'Equipe criada', ['teams'])) && setName(''); }}>
        <input className="input" placeholder="Nome da equipe" value={name} onChange={(e) => setName(e.target.value)} required /><button className="btn primary">Adicionar</button>
      </form>
      {teams?.map((t) => (
        <div key={t.id} className="row">
          <input className="input" defaultValue={t.name} onBlur={(e) => e.target.value !== t.name && m(() => api.patch(`/api/teams/${t.id}`, { name: e.target.value }), 'Equipe renomeada', ['teams'])} />
          <span className="small muted nowrap">{t.members} membro(s)</span>
          <button className="btn sm ghost" onClick={async () => (await confirm({ title: 'Excluir equipe?', text: 'Os membros ficarão sem equipe.', danger: true })) && m(() => api.del(`/api/teams/${t.id}`), 'Equipe excluída', ['teams', 'users'])}>Excluir</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- distribuição
function DistributionTab() {
  const { data: settings } = useSettings();
  const { data: users } = useUsers();
  const m = useMutate();
  const [f, setF] = useState<any>(null);
  const [w, setW] = useState<any>(null);
  useEffect(() => {
    if (settings) {
      setF(settings.distribution);
      setW(settings.whatsapp);
    }
  }, [settings]);
  if (!f || !w) return <Loading />;
  const receivers = users?.filter((u: any) => u.active && u.receives_leads) ?? [];
  return (
    <div className="grid cols-2">
      <form className="card card-pad stack" onSubmit={(e) => { e.preventDefault(); m(() => api.put('/api/settings/distribution', { mode: f.mode, auto_create_opportunity: f.auto_create_opportunity, auto_first_contact_task: f.auto_first_contact_task, first_contact_task_minutes: Number(f.first_contact_task_minutes) }), 'Distribuição salva', ['settings']); }}>
        <h2>Distribuição de novos leads</h2>
        <Field label="Modo">
          <select className="select" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            <option value="round_robin">Rodízio (um para cada vendedor, em sequência)</option>
            <option value="least_loaded">Menor carga (quem tem menos leads em aberto)</option>
            <option value="manual">Manual (gestor distribui)</option>
          </select>
        </Field>
        <div className="small">Participam ({receivers.length}): {receivers.map((u: any) => u.name).join(', ') || <b style={{ color: 'var(--danger)' }}>nenhum vendedor marcado para receber leads (aba Usuários)</b>}</div>
        <label className="check"><input type="checkbox" checked={f.auto_create_opportunity} onChange={(e) => setF({ ...f, auto_create_opportunity: e.target.checked })} /> Criar oportunidade automaticamente para leads de integrações</label>
        <label className="check"><input type="checkbox" checked={f.auto_first_contact_task} onChange={(e) => setF({ ...f, auto_first_contact_task: e.target.checked })} /> Criar tarefa de primeiro contato para o vendedor</label>
        <Field label="Prazo da tarefa de primeiro contato (min)"><input className="input" type="number" min={0} value={f.first_contact_task_minutes} onChange={(e) => setF({ ...f, first_contact_task_minutes: e.target.value })} /></Field>
        <div><button className="btn primary">Salvar</button></div>
      </form>
      <form className="card card-pad stack" onSubmit={(e) => { e.preventDefault(); m(() => api.put('/api/settings/whatsapp', w), 'Configurações de atendimento salvas', ['settings']); }}>
        <h2>Atendimento pelo WhatsApp</h2>
        <label className="check"><input type="checkbox" checked={w.auto_create_lead} onChange={(e) => setW({ ...w, auto_create_lead: e.target.checked })} /> Criar lead automaticamente quando um número desconhecido enviar mensagem</label>
        <Field label="Origem dos leads criados pelo WhatsApp"><input className="input" value={w.default_source} onChange={(e) => setW({ ...w, default_source: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={w.assign_to_lead_owner} onChange={(e) => setW({ ...w, assign_to_lead_owner: e.target.checked })} /> Atribuir conversa ao responsável do lead</label>
        <label className="check"><input type="checkbox" checked={w.distribute_unassigned} onChange={(e) => setW({ ...w, distribute_unassigned: e.target.checked })} /> Distribuir conversas de leads sem responsável</label>
        <label className="check"><input type="checkbox" checked={w.reopen_on_inbound} onChange={(e) => setW({ ...w, reopen_on_inbound: e.target.checked })} /> Reabrir atendimento encerrado quando o cliente enviar nova mensagem</label>
        <div><button className="btn primary">Salvar</button></div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- funis
function PipelinesTab() {
  const { data: pipelines, isLoading } = usePipelines();
  const [edit, setEdit] = useState<any>(null);
  if (isLoading) return <Loading />;
  return (
    <div className="stack">
      <div className="row"><span className="spacer muted small">Edite etapas, ordem, tipo (aberta / ganho / perda), probabilidade e limite de dias para considerar a oportunidade parada.</span><button className="btn primary" onClick={() => setEdit({ name: 'Novo funil', active: true, is_default: false, stages: null })}>+ Novo funil</button></div>
      {pipelines?.map((p) => (
        <div key={p.id} className="card">
          <div className="card-head"><h2>{p.name}</h2>{p.is_default && <Badge color="blue">Padrão</Badge>}{!p.active && <Badge>Inativo</Badge>}<button className="btn sm" onClick={() => setEdit(p)}>Editar</button></div>
          <div className="card-pad row wrap">
            {p.stages.filter((s: any) => !s.archived).map((s: any) => <span key={s.id} className="badge" style={{ background: `${s.color}22`, color: s.color }}>{s.name} · {s.probability}% · {s.opportunities}</span>)}
          </div>
        </div>
      ))}
      {edit && <PipelineEditor pipeline={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PipelineEditor({ pipeline, onClose }: { pipeline: any; onClose: () => void }) {
  const m = useMutate();
  const confirm = useConfirm();
  const creating = !pipeline.id;
  const [name, setName] = useState(pipeline.name);
  const [active, setActive] = useState(pipeline.active);
  const [isDefault, setIsDefault] = useState(pipeline.is_default);
  const [stages, setStages] = useState<any[]>(pipeline.stages ? pipeline.stages.filter((s: any) => !s.archived).map((s: any) => ({ ...s })) : []);
  const [moveTo, setMoveTo] = useState<Record<string, number>>({});
  const removed = (pipeline.stages ?? []).filter((s: any) => !s.archived && !stages.some((x) => x.id === s.id) && s.opportunities > 0);
  const setStage = (i: number, patch: any) => setStages(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const moveStage = (i: number, d: number) => {
    const n = [...stages];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setStages(n);
  };
  const save = async () => {
    const payload = stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, probability: Number(s.probability), stale_after_days: s.stale_after_days === '' ? null : s.stale_after_days, color: s.color }));
    const r = creating
      ? await m(() => api.post('/api/pipelines', { name, is_default: isDefault, ...(stages.length ? { stages: payload } : {}) }), 'Funil criado', ['pipelines', 'board'])
      : await m(() => api.put(`/api/pipelines/${pipeline.id}`, { name, active, is_default: isDefault, stages: payload, move_to: moveTo }), 'Funil atualizado', ['pipelines', 'board']);
    if (r) onClose();
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Excluir funil?', text: 'Se houver oportunidades, ele será apenas desativado.', danger: true }))) return;
    if (await m(() => api.del(`/api/pipelines/${pipeline.id}`), 'Funil excluído', ['pipelines'])) onClose();
  };
  return (
    <Modal size="xl" title={creating ? 'Novo funil' : `Editar funil: ${pipeline.name}`} onClose={onClose} footer={<>{!creating && !pipeline.is_default && <button className="btn ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={remove}>Excluir</button>}<button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
      <div className="stack">
        <div className="row wrap">
          <Field label="Nome"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {!creating && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativo</label>}
          <label className="check"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Funil padrão (novos leads)</label>
        </div>
        {creating && !stages.length && <div className="alert info">O funil será criado com as etapas padrão (Novo lead → … → Matrícula realizada / Perdido). Você poderá editá-las depois.</div>}
        {stages.length > 0 && (
          <table className="table">
            <thead><tr><th /><th>Etapa</th><th>Tipo</th><th>Prob. %</th><th>Parada após (dias)</th><th>Cor</th><th className="num">Oport.</th><th /></tr></thead>
            <tbody>
              {stages.map((s, i) => (
                <tr key={s.id ?? `n${i}`}>
                  <td className="nowrap"><button className="btn sm icon" disabled={i === 0} onClick={() => moveStage(i, -1)}>↑</button><button className="btn sm icon" disabled={i === stages.length - 1} onClick={() => moveStage(i, 1)}>↓</button></td>
                  <td><input className="input sm" value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} /></td>
                  <td><select className="select sm" value={s.kind} onChange={(e) => setStage(i, { kind: e.target.value })}><option value="open">Aberta</option><option value="won">Ganho (matrícula)</option><option value="lost">Perda</option></select></td>
                  <td><input className="input sm" type="number" min={0} max={100} style={{ width: 70 }} value={s.probability} onChange={(e) => setStage(i, { probability: e.target.value })} /></td>
                  <td><input className="input sm" type="number" min={1} style={{ width: 80 }} value={s.stale_after_days ?? ''} placeholder="padrão" onChange={(e) => setStage(i, { stale_after_days: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                  <td><input type="color" value={s.color} onChange={(e) => setStage(i, { color: e.target.value })} /></td>
                  <td className="num">{s.opportunities ?? 0}</td>
                  <td><button className="btn sm ghost" onClick={() => setStages(stages.filter((_, j) => j !== i))}>Remover</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div><button className="btn sm" onClick={() => setStages([...(stages.length ? stages : []), { name: 'Nova etapa', kind: 'open', probability: 50, stale_after_days: '', color: '#64748b' }])}>+ Etapa</button></div>
        {removed.length > 0 && (
          <div className="alert warn">
            <b>Etapas removidas com oportunidades:</b> escolha para onde movê-las.
            {removed.map((s: any) => (
              <div key={s.id} className="row" style={{ marginTop: 6 }}>
                <span>{s.name} ({s.opportunities}) →</span>
                <select className="select sm" style={{ width: 'auto' }} value={moveTo[s.id] ?? ''} onChange={(e) => setMoveTo({ ...moveTo, [s.id]: Number(e.target.value) })}>
                  <option value="">Selecione</option>
                  {stages.filter((x) => x.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- listas simples
function CustomFieldsTab() {
  const { data } = useCustomFields();
  const m = useMutate();
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="card">
      <div className="card-head"><h2>Campos personalizados do lead</h2><button className="btn primary" onClick={() => setEdit({ key: '', label: '', type: 'text', options: [], required: false, position: (data?.length ?? 0) + 1, active: true })}>+ Novo campo</button></div>
      <table className="table">
        <thead><tr><th>Rótulo</th><th>Chave</th><th>Tipo</th><th>Obrigatório</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {data?.map((f) => (
            <tr key={f.id}><td>{f.label}</td><td className="mono">{f.key}</td><td>{f.type}{f.options?.length ? `: ${f.options.join(', ')}` : ''}</td><td>{f.required ? 'Sim' : 'Não'}</td><td>{f.active ? 'Ativo' : 'Inativo'}</td>
              <td><button className="btn sm" onClick={() => setEdit(f)}>Editar</button></td></tr>
          ))}
          {data && !data.length && <tr><td colSpan={6} className="muted">Nenhum campo. Exemplos: escolaridade, melhor horário para contato, unidade de interesse.</td></tr>}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? 'Editar campo' : 'Novo campo'} onClose={() => setEdit(null)} footer={<>{edit.id && <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={async () => (await m(() => api.del(`/api/custom-fields/${edit.id}`), 'Campo excluído', ['custom-fields'])) && setEdit(null)}>Excluir</button>}<button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={async () => {
          const body = { key: edit.key, label: edit.label, type: edit.type, options: edit.options, required: edit.required, position: Number(edit.position), active: edit.active };
          if (await m(() => (edit.id ? api.patch(`/api/custom-fields/${edit.id}`, body) : api.post('/api/custom-fields', body)), 'Campo salvo', ['custom-fields'])) setEdit(null);
        }}>Salvar</button></>}>
          <div className="form-grid">
            <Field label="Rótulo"><input className="input" value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value, key: edit.id ? edit.key : e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} /></Field>
            <Field label="Chave (técnica)" hint="Usada em importações e na API (custom.chave)"><input className="input mono" value={edit.key} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, key: e.target.value })} /></Field>
            <Field label="Tipo"><select className="select" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}><option value="text">Texto</option><option value="textarea">Texto longo</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista de opções</option><option value="boolean">Sim/Não</option></select></Field>
            <Field label="Ordem"><input className="input" type="number" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></Field>
            {edit.type === 'select' && <Field label="Opções (uma por linha)" className="full"><textarea className="textarea" value={edit.options.join('\n')} onChange={(e) => setEdit({ ...edit, options: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></Field>}
            <label className="check"><input type="checkbox" checked={edit.required} onChange={(e) => setEdit({ ...edit, required: e.target.checked })} /> Obrigatório no cadastro manual</label>
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Ativo</label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TagsTab() {
  const { data } = useTags();
  const m = useMutate();
  const confirm = useConfirm();
  const [f, setF] = useState({ name: '', color: '#2563eb' });
  return (
    <div className="card card-pad stack" style={{ maxWidth: 640 }}>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); (await m(() => api.post('/api/tags', f), 'Etiqueta criada', ['tags'])) && setF({ ...f, name: '' }); }}>
        <input className="input" placeholder="Nova etiqueta" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
        <button className="btn primary">Adicionar</button>
      </form>
      {data?.map((t) => (
        <div key={t.id} className="row">
          <span className="tag" style={{ background: t.color }}>{t.name}</span>
          <span className="small muted spacer">{t.leads} lead(s)</span>
          <input type="color" defaultValue={t.color} onBlur={(e) => e.target.value !== t.color && m(() => api.patch(`/api/tags/${t.id}`, { color: e.target.value }), 'Cor atualizada', ['tags'])} />
          <button className="btn sm ghost" onClick={async () => (await confirm({ title: `Excluir etiqueta "${t.name}"?`, text: 'Ela será removida de todos os leads e conversas.', danger: true })) && m(() => api.del(`/api/tags/${t.id}`), 'Etiqueta excluída', ['tags'])}>Excluir</button>
        </div>
      ))}
    </div>
  );
}

function LostReasonsTab() {
  const { data } = useLostReasons();
  const m = useMutate();
  const [name, setName] = useState('');
  return (
    <div className="card card-pad stack" style={{ maxWidth: 640 }}>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); (await m(() => api.post('/api/lost-reasons', { name, position: (data?.length ?? 0) + 1 }), 'Motivo criado', ['lost-reasons'])) && setName(''); }}>
        <input className="input" placeholder="Novo motivo de perda" value={name} onChange={(e) => setName(e.target.value)} required /><button className="btn primary">Adicionar</button>
      </form>
      {data?.map((r) => (
        <div key={r.id} className="row">
          <span className="spacer" style={{ opacity: r.active ? 1 : 0.5 }}>{r.name}</span>
          <button className="btn sm" onClick={() => m(() => api.patch(`/api/lost-reasons/${r.id}`, { active: !r.active }), r.active ? 'Motivo desativado' : 'Motivo ativado', ['lost-reasons'])}>{r.active ? 'Desativar' : 'Ativar'}</button>
        </div>
      ))}
    </div>
  );
}

function QuickRepliesTab() {
  const { isManager } = useAuth();
  const { data } = useQuickReplies();
  const m = useMutate();
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="card">
      <div className="card-head"><h2>Respostas rápidas</h2><span className="small muted">No chat, digite “/” + atalho. Use {'{{nome}}'} para o primeiro nome do contato.</span><button className="btn primary" onClick={() => setEdit({ shortcut: '', title: '', body: '', shared: isManager })}>+ Nova</button></div>
      <table className="table">
        <thead><tr><th>Atalho</th><th>Título</th><th>Texto</th><th>Uso</th><th /></tr></thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}><td className="mono">/{r.shortcut}</td><td>{r.title}</td><td className="small ellipsis" style={{ maxWidth: 420 }}>{r.body}</td><td>{r.owner_id ? 'Pessoal' : 'Equipe'}</td>
              <td className="nowrap"><button className="btn sm" onClick={() => setEdit({ ...r, shared: !r.owner_id })}>Editar</button><button className="btn sm ghost" onClick={() => m(() => api.del(`/api/quick-replies/${r.id}`), 'Resposta excluída', ['quick-replies'])}>Excluir</button></td></tr>
          ))}
          {data && !data.length && <tr><td colSpan={5} className="muted">Nenhuma resposta rápida.</td></tr>}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.id ? 'Editar resposta' : 'Nova resposta rápida'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={async () => {
          const body = { shortcut: edit.shortcut, title: edit.title, body: edit.body, shared: edit.shared };
          if (await m(() => (edit.id ? api.patch(`/api/quick-replies/${edit.id}`, body) : api.post('/api/quick-replies', body)), 'Resposta salva', ['quick-replies'])) setEdit(null);
        }}>Salvar</button></>}>
          <div className="form-grid">
            <Field label="Atalho"><input className="input" value={edit.shortcut} onChange={(e) => setEdit({ ...edit, shortcut: e.target.value.replace(/\s/g, '') })} placeholder="boasvindas" /></Field>
            <Field label="Título"><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Texto" className="full"><textarea className="textarea" rows={6} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            {isManager && !edit.id && <label className="check full"><input type="checkbox" checked={edit.shared} onChange={(e) => setEdit({ ...edit, shared: e.target.checked })} /> Compartilhar com toda a equipe</label>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CampaignsTab() {
  const { data, isLoading } = useCampaigns();
  const m = useMutate();
  const [edit, setEdit] = useState<any>(null);
  const [spendFor, setSpendFor] = useState<any>(null);
  if (isLoading) return <Loading />;
  return (
    <div className="card">
      <div className="card-head"><h2>Campanhas</h2><span className="small muted">Campanhas são criadas automaticamente a partir de utm_campaign e do Meta Lead Ads.</span><button className="btn primary" onClick={() => setEdit({ name: '', utm_campaign: '', channel: '', external_id: '', start_date: '', end_date: '', active: true, notes: '' })}>+ Nova</button></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Campanha</th><th>Canal</th><th>utm_campaign</th><th>Período</th><th className="num">Leads</th><th className="num">Investimento</th><th /></tr></thead>
          <tbody>
            {data?.map((c) => (
              <tr key={c.id} style={{ opacity: c.active ? 1 : 0.6 }}>
                <td className="cell-main">{c.name}{c.external_id && <div className="cell-sub">ID externo {c.external_id}</div>}</td><td>{c.channel ?? '—'}</td><td className="mono">{c.utm_campaign ?? '—'}</td>
                <td className="small">{c.start_date ? fmtDate(c.start_date) : '—'} a {c.end_date ? fmtDate(c.end_date) : '—'}</td><td className="num">{c.leads}</td><td className="num">{money(c.spend)}</td>
                <td className="nowrap"><button className="btn sm" onClick={() => setSpendFor(c)}>Investimento</button><button className="btn sm" onClick={() => setEdit(c)}>Editar</button></td>
              </tr>
            ))}
            {data && !data.length && <tr><td colSpan={7}><Empty icon="📣" text="Nenhuma campanha ainda." /></td></tr>}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Editar campanha' : 'Nova campanha'} onClose={() => setEdit(null)} footer={<>{edit.id && <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={async () => (await m(() => api.del(`/api/campaigns/${edit.id}`), 'Campanha excluída', ['campaigns'])) && setEdit(null)}>Excluir</button>}<button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={async () => {
          const body = { name: edit.name, utm_campaign: edit.utm_campaign, channel: edit.channel, external_id: edit.external_id, start_date: edit.start_date, end_date: edit.end_date, active: edit.active, notes: edit.notes };
          if (await m(() => (edit.id ? api.patch(`/api/campaigns/${edit.id}`, body) : api.post('/api/campaigns', body)), 'Campanha salva', ['campaigns'])) setEdit(null);
        }}>Salvar</button></>}>
          <div className="form-grid">
            <Field label="Nome" className="full"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="utm_campaign" hint="Leads com este utm_campaign são associados automaticamente"><input className="input mono" value={edit.utm_campaign ?? ''} onChange={(e) => setEdit({ ...edit, utm_campaign: e.target.value })} /></Field>
            <Field label="Canal"><input className="input" list="channels" value={edit.channel ?? ''} onChange={(e) => setEdit({ ...edit, channel: e.target.value })} /><datalist id="channels"><option value="meta_ads" /><option value="google_ads" /><option value="organico" /><option value="email" /><option value="indicacao" /></datalist></Field>
            <Field label="ID externo (ex.: campanha Meta)"><input className="input" value={edit.external_id ?? ''} onChange={(e) => setEdit({ ...edit, external_id: e.target.value })} /></Field>
            <Field label="Início"><input className="input" type="date" value={edit.start_date ?? ''} onChange={(e) => setEdit({ ...edit, start_date: e.target.value })} /></Field>
            <Field label="Fim"><input className="input" type="date" value={edit.end_date ?? ''} onChange={(e) => setEdit({ ...edit, end_date: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Ativa</label>
            <Field label="Observações" className="full"><textarea className="textarea" value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {spendFor && <SpendModal campaign={spendFor} onClose={() => setSpendFor(null)} />}
    </div>
  );
}

function SpendModal({ campaign, onClose }: { campaign: any; onClose: () => void }) {
  const m = useMutate();
  const { data, refetch } = useQuery({ queryKey: ['spend', campaign.id], queryFn: () => api.get(`/api/campaigns/${campaign.id}/spend`) });
  const [f, setF] = useState({ day: '', amount: '' });
  return (
    <Modal size="lg" title={`Investimento — ${campaign.name}`} onClose={onClose}>
      <div className="stack">
        <div className="small muted">Lance o investimento diário (ou o total no primeiro dia do período). Usado para CPL, CPA e ROAS. Valores importados do Meta Ads aparecem como “meta_ads”.</div>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await m(() => api.post(`/api/campaigns/${campaign.id}/spend`, { day: f.day, amount: Number(f.amount) }), 'Investimento lançado', ['campaigns'])) { setF({ day: '', amount: '' }); refetch(); } }}>
          <input className="input" type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} required />
          <input className="input" type="number" step="0.01" min={0} placeholder="Valor (R$)" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
          <button className="btn primary">Lançar</button>
        </form>
        <table className="table">
          <thead><tr><th>Dia</th><th className="num">Valor</th><th className="num">Cliques</th><th>Fonte</th><th /></tr></thead>
          <tbody>
            {data?.map((s: any) => (
              <tr key={s.id}><td>{fmtDate(s.day)}</td><td className="num">{money(s.amount)}</td><td className="num">{s.clicks ?? '—'}</td><td>{s.source}</td>
                <td>{s.source === 'manual' && <button className="btn sm ghost" onClick={async () => (await m(() => api.del(`/api/campaign-spend/${s.id}`), 'Lançamento excluído', ['campaigns'])) && refetch()}>Excluir</button>}</td></tr>
            ))}
            {data && !data.length && <tr><td colSpan={5} className="muted">Nenhum investimento registrado.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function GeneralTab() {
  const { data: settings } = useSettings();
  const m = useMutate();
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (settings) setF({ ...settings.general, sources: settings.general.sources.join('\n') });
  }, [settings]);
  if (!f) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m(() => api.put('/api/settings/general', {
      company_name: f.company_name, sla_first_contact_minutes: Number(f.sla_first_contact_minutes), stale_lead_days: Number(f.stale_lead_days), reactivation_days: Number(f.reactivation_days),
      opportunity_stale_days: Number(f.opportunity_stale_days), sellers_see_unassigned: f.sellers_see_unassigned, sources: f.sources.split('\n').map((s: string) => s.trim()).filter(Boolean),
    }), 'Configurações salvas', ['settings', 'dashboard']);
  };
  return (
    <form className="card card-pad form-grid" style={{ maxWidth: 820 }} onSubmit={submit}>
      <Field label="Nome da empresa" className="full"><input className="input" value={f.company_name} onChange={(e) => setF({ ...f, company_name: e.target.value })} /></Field>
      <Field label="SLA de primeiro contato (min)" hint="Alertas e indicadores de leads sem contato"><input className="input" type="number" min={1} value={f.sla_first_contact_minutes} onChange={(e) => setF({ ...f, sla_first_contact_minutes: e.target.value })} /></Field>
      <Field label="Lead parado após (dias sem interação)"><input className="input" type="number" min={1} value={f.stale_lead_days} onChange={(e) => setF({ ...f, stale_lead_days: e.target.value })} /></Field>
      <Field label="Oportunidade parada após (dias na etapa)" hint="Quando a etapa não define um limite próprio"><input className="input" type="number" min={1} value={f.opportunity_stale_days} onChange={(e) => setF({ ...f, opportunity_stale_days: e.target.value })} /></Field>
      <Field label="Sugerir reativação após (dias)"><input className="input" type="number" min={1} value={f.reactivation_days} onChange={(e) => setF({ ...f, reactivation_days: e.target.value })} /></Field>
      <label className="check full"><input type="checkbox" checked={f.sellers_see_unassigned} onChange={(e) => setF({ ...f, sellers_see_unassigned: e.target.checked })} /> Vendedores podem ver (e assumir) leads e conversas sem responsável</label>
      <Field label="Origens de lead (uma por linha)" className="full"><textarea className="textarea" rows={8} value={f.sources} onChange={(e) => setF({ ...f, sources: e.target.value })} /></Field>
      <div className="full"><button className="btn primary">Salvar</button></div>
    </form>
  );
}

function AuditTab() {
  const [f, setF] = useState({ action: '', user_id: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const { data: users } = useUsers();
  const { data, isLoading, error } = useQuery({ queryKey: ['audit', f, page], queryFn: () => api.get('/api/audit', { ...f, page, pageSize: 50 }) });
  return (
    <div className="card">
      <div className="card-pad filters" style={{ marginBottom: 0 }}>
        <Field label="Ação"><input className="input" value={f.action} onChange={(e) => { setF({ ...f, action: e.target.value }); setPage(1); }} placeholder="ex.: lead.export, auth.login" /></Field>
        <Field label="Usuário"><select className="select" value={f.user_id} onChange={(e) => { setF({ ...f, user_id: e.target.value }); setPage(1); }}><option value="">Todos</option>{users?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="De"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="Até"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Registro</th><th>Detalhes</th><th>IP</th></tr></thead>
          <tbody>
            {data?.rows.map((a: any) => (
              <tr key={a.id}><td className="nowrap small">{fmtDateTime(a.created_at)}</td><td>{a.user_name ?? '—'}</td><td className="mono">{a.action}</td><td className="small">{a.entity_type ? `${a.entity_type} #${a.entity_id ?? ''}` : ''}</td>
                <td className="mono small ellipsis" style={{ maxWidth: 420 }} title={JSON.stringify(a.changes)}>{a.changes ? JSON.stringify(a.changes) : ''}</td><td className="small">{a.ip}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />}
    </div>
  );
}
