import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Drawer, Empty, ErrorBox, Field, Loading, Modal, useConfirm, useToast } from '../components/ui';
import { fmtDate, KIND_LABELS, money, num } from '../format';
import { useCourses } from '../hooks';

export default function Catalog() {
  const { isManager } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [filter, setFilter] = useState({ q: '', active: 'true', kind: '' });
  const [view, setView] = useState<number | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const { data, isLoading, error, refetch } = useCourses();
  const { data: cats } = useQuery({ queryKey: ['course-categories'], queryFn: () => api.get('/api/course-categories') });
  useEffect(() => {
    if (sp.get('curso')) {
      setView(Number(sp.get('curso')));
      setSp({}, { replace: true });
    }
  }, [sp]); // eslint-disable-line
  const rows = (data ?? []).filter((c) =>
    (!filter.q || c.name.toLowerCase().includes(filter.q.toLowerCase()) || (c.code ?? '').toLowerCase().includes(filter.q.toLowerCase())) &&
    (filter.active === '' || String(c.active) === filter.active) && (!filter.kind || c.kind === filter.kind));
  return (
    <div>
      <div className="page-head">
        <h1>Catálogo de cursos e formações</h1>
        <span className="grow" />
        {isManager && <button className="btn" onClick={() => setEdit('categories')}>Categorias</button>}
        {isManager && <button className="btn primary" onClick={() => setEdit({})}>+ Novo curso</button>}
      </div>
      <div className="filters">
        <Field label="Buscar" className="wide"><input className="input" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder="Nome ou código" /></Field>
        <Field label="Tipo">
          <select className="select" value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value })}>
            <option value="">Todos</option>{Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Situação">
          <select className="select" value={filter.active} onChange={(e) => setFilter({ ...filter, active: e.target.value })}>
            <option value="true">Ativos</option><option value="false">Inativos</option><option value="">Todos</option>
          </select>
        </Field>
      </div>
      <div className="card">
        {isLoading && <Loading />}
        {error && <ErrorBox error={error} retry={refetch} />}
        {data && !rows.length && <Empty icon="🎓" text="Nenhum curso encontrado." />}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Curso</th><th>Tipo / categoria</th><th>Modalidade</th><th className="num">Carga</th><th className="num">Preço</th><th className="num">Interessados</th><th className="num">Em negociação</th><th className="num">Vendas</th><th className="num">Receita</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setView(c.id)}>
                    <td><div className="cell-main">{c.name} {!c.active && <Badge>inativo</Badge>}</div><div className="cell-sub">{c.code ?? ''}</div></td>
                    <td>{KIND_LABELS[c.kind]}<div className="cell-sub">{c.category_name ?? ''}</div></td>
                    <td>{c.modality ?? '—'}</td>
                    <td className="num">{c.workload_hours ? `${c.workload_hours}h` : '—'}</td>
                    <td className="num">{c.promo_price ? <><s className="muted">{money(c.price)}</s><br /><b>{money(c.promo_price)}</b></> : money(c.price)}</td>
                    <td className="num">{num(c.interested)}</td>
                    <td className="num">{num(c.open_opportunities)}</td>
                    <td className="num">{num(c.sales)}</td>
                    <td className="num">{money(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {view && <CourseView id={view} onClose={() => setView(null)} onEdit={(c) => { setView(null); setEdit(c); }} />}
      {edit === 'categories' && <Categories cats={cats ?? []} onClose={() => setEdit(null)} />}
      {edit && edit !== 'categories' && <CourseForm course={edit} cats={cats ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CourseView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (c: any) => void }) {
  const { isManager } = useAuth();
  const { data: c, isLoading } = useQuery({ queryKey: ['course', id], queryFn: () => api.get(`/api/courses/${id}`) });
  return (
    <Drawer title={c?.name ?? 'Curso'} onClose={onClose} footer={isManager && c && <button className="btn primary" onClick={() => onEdit(c)}>Editar</button>}>
      {isLoading || !c ? <Loading /> : (
        <div className="stack">
          <div className="row wrap"><Badge color="blue">{KIND_LABELS[c.kind]}</Badge>{c.category_name && <Badge>{c.category_name}</Badge>}{!c.active && <Badge color="red">Inativo</Badge>}{c.code && <span className="mono">{c.code}</span>}</div>
          <div className="kpis">
            <div className="card kpi"><div className="label">Interessados</div><div className="value">{num(c.stats.interested)}</div></div>
            <div className="card kpi"><div className="label">Vendas</div><div className="value">{num(c.stats.sales)}</div><div className="foot">{c.stats.lost} perdidas</div></div>
            <div className="card kpi"><div className="label">Receita</div><div className="value" style={{ fontSize: 18 }}>{money(c.stats.revenue)}</div><div className="foot">ticket {money(c.stats.avg_ticket)}</div></div>
          </div>
          <div className="kv">
            <span className="k">Modalidade</span><span>{c.modality ?? '—'}</span>
            <span className="k">Carga horária</span><span>{c.workload_hours ? `${c.workload_hours} horas` : '—'}</span>
            <span className="k">Preço</span><span>{money(c.price)}</span>
            <span className="k">Promocional</span><span>{c.promo_price ? `${money(c.promo_price)}${c.promo_until ? ` até ${fmtDate(c.promo_until)}` : ''}` : '—'}</span>
          </div>
          {c.description && <div><h3>Descrição</h3><div style={{ whiteSpace: 'pre-wrap' }}>{c.description}</div></div>}
          {c.commercial_conditions && <div><h3>Condições comerciais</h3><div style={{ whiteSpace: 'pre-wrap' }}>{c.commercial_conditions}</div></div>}
          {c.seller_notes && <div className="alert info"><b>Para os vendedores:</b><div style={{ whiteSpace: 'pre-wrap' }}>{c.seller_notes}</div></div>}
          {c.materials?.length > 0 && <div><h3>Materiais de apoio</h3>{c.materials.map((m: any) => <div key={m.id}><a href={m.url} target="_blank" rel="noreferrer">🔗 {m.title}</a></div>)}</div>}
        </div>
      )}
    </Drawer>
  );
}

function CourseForm({ course, cats, onClose }: { course: any; cats: any[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const editing = !!course.id;
  const [f, setF] = useState<any>({
    name: course.name ?? '', code: course.code ?? '', kind: course.kind ?? 'course', category_id: course.category_id ?? '', description: course.description ?? '',
    modality: course.modality ?? '', workload_hours: course.workload_hours ?? '', price: course.price ?? '', promo_price: course.promo_price ?? '', promo_until: course.promo_until ?? '',
    commercial_conditions: course.commercial_conditions ?? '', seller_notes: course.seller_notes ?? '', active: course.active ?? true, materials: course.materials ?? [],
  });
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, materials: f.materials.filter((m: any) => m.title && m.url) };
      if (editing) await api.patch(`/api/courses/${course.id}`, body);
      else await api.post('/api/courses', body);
      toast('Curso salvo');
      qc.invalidateQueries({ queryKey: ['courses'] });
      qc.invalidateQueries({ queryKey: ['course'] });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Excluir curso?', text: 'Se houver leads ou oportunidades vinculados, o curso será apenas inativado.', danger: true, confirm: 'Excluir' }))) return;
    try {
      const r = await api.del(`/api/courses/${course.id}`);
      toast(r.message ?? 'Curso excluído');
      qc.invalidateQueries({ queryKey: ['courses'] });
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal size="lg" title={editing ? 'Editar curso' : 'Novo curso'} onClose={onClose} footer={<>{editing && <button className="btn ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={remove}>Excluir</button>}<button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="course-form">Salvar</button></>}>
      <form id="course-form" className="form-grid" onSubmit={submit}>
        <Field label="Nome *" className="full"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required /></Field>
        <Field label="Código" hint="Usado por formulários e integrações (ex.: TEC-INFO)"><input className="input" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        <Field label="Tipo"><select className="select" value={f.kind} onChange={(e) => set('kind', e.target.value)}>{Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Categoria"><select className="select" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Modalidade"><input className="input" list="modalities" value={f.modality} onChange={(e) => set('modality', e.target.value)} /><datalist id="modalities"><option value="Presencial" /><option value="Online (EAD)" /><option value="Híbrido" /><option value="Ao vivo" /></datalist></Field>
        <Field label="Carga horária (h)"><input className="input" type="number" min={0} value={f.workload_hours} onChange={(e) => set('workload_hours', e.target.value)} /></Field>
        <Field label="Preço (R$)"><input className="input" type="number" step="0.01" min={0} value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
        <Field label="Preço promocional (R$)"><input className="input" type="number" step="0.01" min={0} value={f.promo_price} onChange={(e) => set('promo_price', e.target.value)} /></Field>
        <Field label="Promoção válida até"><input className="input" type="date" value={f.promo_until} onChange={(e) => set('promo_until', e.target.value)} /></Field>
        <Field label="Descrição" className="full"><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Condições comerciais" className="full" hint="Parcelamento, descontos, formas de pagamento"><textarea className="textarea" value={f.commercial_conditions} onChange={(e) => set('commercial_conditions', e.target.value)} /></Field>
        <Field label="Informações para os vendedores" className="full" hint="Argumentos, público-alvo, objeções comuns"><textarea className="textarea" value={f.seller_notes} onChange={(e) => set('seller_notes', e.target.value)} /></Field>
        <div className="full">
          <div className="row"><b className="spacer">Materiais comerciais e links</b><button type="button" className="btn sm" onClick={() => set('materials', [...f.materials, { title: '', url: '' }])}>+ Link</button></div>
          {f.materials.map((m: any, i: number) => (
            <div key={i} className="row" style={{ marginTop: 6 }}>
              <input className="input" placeholder="Título" value={m.title} onChange={(e) => set('materials', f.materials.map((x: any, j: number) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input className="input" placeholder="https://..." value={m.url} onChange={(e) => set('materials', f.materials.map((x: any, j: number) => (j === i ? { ...x, url: e.target.value } : x)))} />
              <button type="button" className="btn icon" onClick={() => set('materials', f.materials.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <label className="check full"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Ativo (disponível para novos leads e oportunidades)</label>
      </form>
    </Modal>
  );
}

function Categories({ cats, onClose }: { cats: any[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const run = async (fn: () => Promise<any>) => {
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ['course-categories'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal title="Categorias" onClose={onClose}>
      <div className="stack">
        <form className="row" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/course-categories', { name })).then(() => setName('')); }}>
          <input className="input" placeholder="Nova categoria" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="btn primary">Adicionar</button>
        </form>
        {cats.map((c) => (
          <div key={c.id} className="row"><span className="spacer">{c.name}</span><button className="btn sm" onClick={() => run(() => api.del(`/api/course-categories/${c.id}`))}>Excluir</button></div>
        ))}
      </div>
    </Modal>
  );
}
