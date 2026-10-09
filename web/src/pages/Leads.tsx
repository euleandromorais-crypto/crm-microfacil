import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { LeadFormModal, StatusBadge, TagList, UserSelect } from '../components/forms';
import { Empty, ErrorBox, Field, Loading, Modal, MultiSelect, Pagination, useConfirm, useDebounced, usePersistentState, useToast } from '../components/ui';
import { fmtPhone, relative, STATUS_LABELS } from '../format';
import { useCampaigns, useCourses, useCustomFields, useSettings, useTags, useUsers } from '../hooks';

const EMPTY = { q: '', status: [] as string[], owner_id: [] as string[], course_id: [] as string[], source: [] as string[], campaign_id: [] as string[], tag_id: [] as string[], created_from: '', created_to: '', no_contact: false, stale_days: '', reactivation: false, awaiting_reply: false, utm_source: '', sort: 'created_at', dir: 'desc', pageSize: 50 };

export default function Leads() {
  const { isManager } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const [f, setF] = usePersistentState('leads-filters', EMPTY);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [modal, setModal] = useState<'new' | 'import' | null>(null);
  const [showMore, setShowMore] = useState(false);
  const { data: users } = useUsers();
  const { data: courses } = useCourses();
  const { data: tags } = useTags();
  const { data: campaigns } = useCampaigns();
  const { data: settings } = useSettings();

  // filtros vindos de links (ex.: indicadores da Central)
  useEffect(() => {
    if (![...sp.keys()].length) return;
    const next: any = { ...EMPTY, sort: f.sort, dir: f.dir, pageSize: f.pageSize };
    for (const [k, v] of sp.entries()) {
      if (['status', 'owner_id', 'course_id', 'source', 'campaign_id', 'tag_id'].includes(k)) next[k] = v.split(',');
      else if (['no_contact', 'reactivation', 'awaiting_reply'].includes(k)) next[k] = v === 'true';
      else next[k] = v;
    }
    setF(next);
    setSp({}, { replace: true });
  }, []); // eslint-disable-line

  const dq = useDebounced(f.q, 300);
  const params = useMemo(() => ({
    q: dq, status: f.status, owner_id: f.owner_id, course_id: f.course_id, source: f.source, campaign_id: f.campaign_id, tag_id: f.tag_id,
    created_from: f.created_from, created_to: f.created_to, no_contact: f.no_contact || undefined, stale_days: f.stale_days, reactivation: f.reactivation || undefined,
    awaiting_reply: f.awaiting_reply || undefined, utm_source: f.utm_source, sort: f.sort, dir: f.dir,
  }), [dq, f]);
  useEffect(() => setPage(1), [params]);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['leads', params, page, f.pageSize],
    queryFn: () => api.get('/api/leads', { ...params, page, pageSize: f.pageSize }),
    placeholderData: keepPreviousData,
  });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const activeCount = ['status', 'owner_id', 'course_id', 'source', 'campaign_id', 'tag_id'].filter((k) => (f as any)[k].length).length +
    ['created_from', 'created_to', 'stale_days', 'utm_source'].filter((k) => (f as any)[k]).length + [f.no_contact, f.reactivation, f.awaiting_reply].filter(Boolean).length;
  const sortBy = (k: string) => setF((x: any) => ({ ...x, sort: k, dir: x.sort === k && x.dir === 'desc' ? 'asc' : 'desc' }));
  const arrow = (k: string) => (f.sort === k ? (f.dir === 'desc' ? ' ↓' : ' ↑') : '');

  const bulk = async (action: string, extra: any = {}) => {
    if (!selected.length) return;
    if (action === 'delete' && !(await confirm({ title: `Excluir ${selected.length} lead(s)?`, text: 'Os leads serão removidos das listas. O histórico fica preservado para auditoria.', danger: true, confirm: 'Excluir' }))) return;
    try {
      const r = await api.post('/api/leads/bulk', { ids: selected, action, ...extra });
      toast(`${r.affected} lead(s) atualizado(s)`);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const rows = data?.rows ?? [];
  const allSel = rows.length > 0 && rows.every((r: any) => selected.includes(r.id));

  return (
    <div>
      <div className="page-head">
        <h1>Leads</h1>
        <span className="sub">{data ? `${data.total.toLocaleString('pt-BR')} encontrados` : ''}{isFetching && !isLoading ? ' · atualizando...' : ''}</span>
        <span className="grow" />
        {isManager && <Link className="btn" to="/leads/duplicados">Duplicados</Link>}
        {isManager && <button className="btn" onClick={() => setModal('import')}>Importar CSV</button>}
        {isManager && (
          <button className="btn" onClick={() => download('/api/leads/export', { ...params, format: 'xlsx' }).catch((e) => toast(e.message, 'error'))}>Exportar Excel</button>
        )}
        {isManager && (
          <button className="btn" onClick={() => download('/api/leads/export', { ...params, format: 'csv' }).catch((e) => toast(e.message, 'error'))}>CSV</button>
        )}
        <button className="btn primary" onClick={() => setModal('new')}>+ Novo lead</button>
      </div>

      <div className="card card-pad" style={{ marginBottom: 12, padding: 12 }}>
        <div className="filters" style={{ marginBottom: 0 }}>
          <Field label="Buscar" className="wide"><input className="input" placeholder="Nome, telefone, e-mail ou #ID" value={f.q} onChange={(e) => set('q', e.target.value)} /></Field>
          <Field label="Status"><MultiSelect options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))} value={f.status} onChange={(v) => set('status', v)} /></Field>
          {isManager && <Field label="Responsável"><MultiSelect options={[{ value: 'none', label: 'Sem responsável' }, ...(users ?? []).map((u) => ({ value: String(u.id), label: u.name }))]} value={f.owner_id} onChange={(v) => set('owner_id', v)} /></Field>}
          <Field label="Curso"><MultiSelect options={(courses ?? []).map((c) => ({ value: String(c.id), label: c.name }))} value={f.course_id} onChange={(v) => set('course_id', v)} /></Field>
          <button className="btn" onClick={() => setShowMore(!showMore)}>Mais filtros{activeCount ? ` (${activeCount})` : ''}</button>
          {activeCount > 0 && <button className="btn ghost" onClick={() => setF({ ...EMPTY, sort: f.sort, dir: f.dir, pageSize: f.pageSize })}>Limpar</button>}
        </div>
        {showMore && (
          <div className="filters" style={{ marginTop: 10, marginBottom: 0 }}>
            <Field label="Origem"><MultiSelect options={(settings?.general?.sources ?? []).map((s: string) => ({ value: s, label: s }))} value={f.source} onChange={(v) => set('source', v)} /></Field>
            <Field label="Campanha"><MultiSelect options={(campaigns ?? []).map((c) => ({ value: String(c.id), label: c.name }))} value={f.campaign_id} onChange={(v) => set('campaign_id', v)} /></Field>
            <Field label="Etiquetas"><MultiSelect options={(tags ?? []).map((t) => ({ value: String(t.id), label: t.name }))} value={f.tag_id} onChange={(v) => set('tag_id', v)} /></Field>
            <Field label="Entrada de"><input className="input" type="date" value={f.created_from} onChange={(e) => set('created_from', e.target.value)} /></Field>
            <Field label="até"><input className="input" type="date" value={f.created_to} onChange={(e) => set('created_to', e.target.value)} /></Field>
            <Field label="utm_source"><input className="input" value={f.utm_source} onChange={(e) => set('utm_source', e.target.value)} /></Field>
            <Field label="Sem interação há (dias)"><input className="input" type="number" min={1} value={f.stale_days} onChange={(e) => set('stale_days', e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={f.no_contact} onChange={(e) => set('no_contact', e.target.checked)} /> Sem contato inicial</label>
            <label className="check"><input type="checkbox" checked={f.awaiting_reply} onChange={(e) => set('awaiting_reply', e.target.checked)} /> Aguardando resposta</label>
            <label className="check"><input type="checkbox" checked={f.reactivation} onChange={(e) => set('reactivation', e.target.checked)} /> Para reativação</label>
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="sticky-actions" style={{ marginBottom: 10, position: 'static' }}>
          <b>{selected.length} selecionado(s)</b>
          {isManager && (
            <>
              <UserSelect className="sm" value={null} placeholder="Atribuir a..." onChange={(v) => v && bulk('assign', { owner_id: v })} />
              <button className="btn sm" onClick={() => bulk('distribute')}>Distribuir automaticamente</button>
            </>
          )}
          <select className="select sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk('status', { status: e.target.value })}>
            <option value="">Alterar status...</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="select sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk('add_tag', { tag_id: Number(e.target.value) })}>
            <option value="">Adicionar etiqueta...</option>
            {tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="select sm" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && bulk('remove_tag', { tag_id: Number(e.target.value) })}>
            <option value="">Remover etiqueta...</option>
            {tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {isManager && <button className="btn sm danger" onClick={() => bulk('delete')}>Excluir</button>}
          <button className="btn sm ghost" onClick={() => setSelected([])}>Limpar seleção</button>
        </div>
      )}

      <div className="card">
        {isLoading && <Loading />}
        {error && <ErrorBox error={error} retry={refetch} />}
        {data && !rows.length && <Empty icon="🔎" text="Nenhum lead encontrado com os filtros atuais." />}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}><input type="checkbox" checked={allSel} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map((r: any) => r.id)])] : selected.filter((id) => !rows.some((r: any) => r.id === id)))} aria-label="Selecionar todos" /></th>
                  <th className="sortable" onClick={() => sortBy('name')}>Lead{arrow('name')}</th>
                  <th className="sortable" onClick={() => sortBy('status')}>Status{arrow('status')}</th>
                  <th className="hide-mobile">Curso</th>
                  <th className="hide-mobile">Origem / campanha</th>
                  <th className="sortable" onClick={() => sortBy('owner')}>Responsável{arrow('owner')}</th>
                  <th className="sortable hide-mobile" onClick={() => sortBy('last_interaction_at')}>Última interação{arrow('last_interaction_at')}</th>
                  <th className="sortable" onClick={() => sortBy('created_at')}>Entrada{arrow('created_at')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l: any) => (
                  <tr key={l.id} className={`clickable ${selected.includes(l.id) ? 'selected' : ''}`} onClick={() => nav(`/leads/${l.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.includes(l.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))} aria-label={`Selecionar ${l.name}`} /></td>
                    <td>
                      <div className="cell-main">{l.name} {l.awaiting_reply && <span title="Aguardando resposta">💬</span>} {l.reactivation_flag && <span title="Reativação">♻️</span>}</div>
                      <div className="cell-sub">{fmtPhone(l.phone)} {l.email && `· ${l.email}`}</div>
                      <TagList ids={l.tag_ids} />
                    </td>
                    <td><StatusBadge status={l.status} />{!l.first_contact_at && ['new', 'attempting'].includes(l.status) && <div className="cell-sub" style={{ color: 'var(--danger)' }}>sem contato</div>}</td>
                    <td className="hide-mobile">{l.course_name ?? <span className="muted">—</span>}</td>
                    <td className="hide-mobile"><div>{l.source ?? '—'}</div><div className="cell-sub">{l.campaign_name ?? l.utm_campaign ?? ''}</div></td>
                    <td>{l.owner_name ?? <span className="muted">Sem responsável</span>}</td>
                    <td className="hide-mobile nowrap">{relative(l.last_interaction_at)}</td>
                    <td className="nowrap">{relative(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={page} pageSize={f.pageSize} total={data.total} onPage={setPage} onPageSize={(s) => set('pageSize', s)} />}
      </div>
      {modal === 'new' && <LeadFormModal onClose={() => setModal(null)} onSaved={(l) => nav(`/leads/${l.id}`)} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} />}
    </div>
  );
}

const IMPORT_FIELDS: [string, string][] = [
  ['', '— Ignorar —'], ['name', 'Nome'], ['phone', 'Telefone'], ['email', 'E-mail'], ['course', 'Curso (código ou nome)'], ['source', 'Origem'], ['campaign', 'Campanha'],
  ['city', 'Cidade'], ['state', 'UF'], ['document', 'CPF/Documento'], ['notes', 'Observações'], ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'],
  ['utm_campaign', 'utm_campaign'], ['utm_term', 'utm_term'], ['utm_content', 'utm_content'],
];

function ImportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: fields } = useCustomFields();
  const { data: tags } = useTags();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [opts, setOpts] = useState<any>({ distribute: true, create_opportunity: true, source: 'Importação', owner_id: null, tag_id: null });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const allFields = [...IMPORT_FIELDS, ...(fields ?? []).map((d) => [`cf_${d.key}`, `Campo: ${d.label}`] as [string, string])];

  const doPreview = async (fl: File) => {
    setFile(fl);
    const fd = new FormData();
    fd.append('mode', 'preview');
    fd.append('file', fl);
    try {
      const p = await api.upload('/api/leads/import', fd);
      setPreview(p);
      setMapping(p.suggested);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('mode', 'commit');
    fd.append('mapping', JSON.stringify(mapping));
    fd.append('options', JSON.stringify(opts));
    fd.append('file', file);
    try {
      const r = await api.upload('/api/leads/import', fd);
      setResult(r);
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="xl" title="Importar leads (CSV)" onClose={onClose} footer={
      result ? <button className="btn primary" onClick={onClose}>Concluir</button> : (
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!preview || busy} onClick={run}>{busy ? 'Importando... (não feche)' : `Importar ${preview?.total ?? ''} linhas`}</button>
        </>
      )
    }>
      {result ? (
        <div className="stack">
          <div className="alert success">{result.created} lead(s) criado(s) · {result.updated} já existente(s) atualizado(s) (duplicidade detectada por telefone/e-mail).</div>
          {result.errors.length > 0 && (
            <div className="alert warn">
              <b>{result.errors.length} linha(s) com erro:</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 200, overflowY: 'auto' }}>{result.errors.map((e: any) => <li key={e.line}>Linha {e.line}: {e.error}</li>)}</ul>
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="alert info">Arquivo CSV com cabeçalho na primeira linha (separador vírgula ou ponto e vírgula). Leads com telefone ou e-mail já cadastrados não serão duplicados: os dados que faltam são completados.</div>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && doPreview(e.target.files[0])} />
          {preview && (
            <>
              <div className="form-grid">
                <label className="check"><input type="checkbox" checked={opts.distribute} onChange={(e) => setOpts({ ...opts, distribute: e.target.checked })} /> Distribuir entre vendedores (regra configurada)</label>
                <label className="check"><input type="checkbox" checked={opts.create_opportunity} onChange={(e) => setOpts({ ...opts, create_opportunity: e.target.checked })} /> Criar oportunidade no funil</label>
                <Field label="Origem padrão"><input className="input" value={opts.source} onChange={(e) => setOpts({ ...opts, source: e.target.value })} /></Field>
                <Field label="Atribuir todos a"><UserSelect value={opts.owner_id} onChange={(v) => setOpts({ ...opts, owner_id: v })} placeholder="— Conforme distribuição —" /></Field>
                <Field label="Etiqueta para os importados">
                  <select className="select" value={opts.tag_id ?? ''} onChange={(e) => setOpts({ ...opts, tag_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— Nenhuma —</option>
                    {tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="table">
                  <thead>
                    <tr>{preview.headers.map((h: string, i: number) => (
                      <th key={i} style={{ minWidth: 160 }}>
                        <div className="small" style={{ textTransform: 'none' }}>{h}</div>
                        <select className="select sm" value={mapping[i] ?? ''} onChange={(e) => setMapping(mapping.map((m, j) => (j === i ? e.target.value : m)))}>
                          {allFields.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </th>
                    ))}</tr>
                  </thead>
                  <tbody>{preview.sample.map((r: string[], i: number) => <tr key={i}>{preview.headers.map((_: string, j: number) => <td key={j} className="small">{r[j]}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className="small muted">Pré-visualização das 10 primeiras de {preview.total} linhas.</div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
