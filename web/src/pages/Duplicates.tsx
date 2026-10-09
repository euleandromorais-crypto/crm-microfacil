import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { StatusBadge } from '../components/forms';
import { Empty, ErrorBox, Loading, useConfirm, useToast } from '../components/ui';
import { fmtDateTime, fmtPhone } from '../format';

const REASONS: Record<string, string> = { phone: 'Mesmo telefone', email: 'Mesmo e-mail', name: 'Mesmo nome (verifique)' };

export default function Duplicates() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['duplicates'], queryFn: () => api.get('/api/leads/duplicates') });
  return (
    <div>
      <div className="page-head">
        <h1>Leads duplicados</h1>
        <span className="sub">Escolha o cadastro principal; os demais são mesclados nele (conversas, oportunidades, tarefas e histórico são transferidos).</span>
      </div>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} retry={refetch} />}
      {data && !data.length && <div className="card"><Empty icon="✅" text="Nenhum possível duplicado encontrado." /></div>}
      <div className="stack">{data?.map((g: any) => <Group key={`${g.reason}-${g.key}`} g={g} />)}</div>
    </div>
  );
}

function Group({ g }: { g: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [primary, setPrimary] = useState<number>(g.leads[0].id);
  const [chosen, setChosen] = useState<number[]>(g.leads.map((l: any) => l.id));
  const merge = async () => {
    const secondary = chosen.filter((id) => id !== primary);
    if (!secondary.length) return toast('Selecione ao menos um cadastro para mesclar', 'error');
    if (!(await confirm({ title: 'Mesclar cadastros?', text: `${secondary.length} cadastro(s) serão incorporados ao principal. Esta ação não pode ser desfeita.`, confirm: 'Mesclar' }))) return;
    try {
      await api.post('/api/leads/merge', { primary_id: primary, secondary_ids: secondary });
      toast('Cadastros mesclados');
      qc.invalidateQueries({ queryKey: ['duplicates'] });
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="card">
      <div className="card-head"><h3>{REASONS[g.reason]}: <span className="mono">{g.key}</span></h3><button className="btn primary sm" onClick={merge}>Mesclar selecionados</button></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Principal</th><th>Mesclar</th><th>Lead</th><th>Contato</th><th>Status</th><th>Responsável</th><th className="num">Oport.</th><th>Entrada</th></tr></thead>
          <tbody>
            {g.leads.map((l: any) => (
              <tr key={l.id}>
                <td><input type="radio" name={`p-${g.key}`} checked={primary === l.id} onChange={() => setPrimary(l.id)} /></td>
                <td><input type="checkbox" checked={chosen.includes(l.id)} disabled={primary === l.id} onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id] : chosen.filter((x) => x !== l.id))} /></td>
                <td><Link to={`/leads/${l.id}`} className="cell-main">{l.name}</Link> <span className="muted small">#{l.id}</span></td>
                <td className="small">{fmtPhone(l.phone)}<br />{l.email}</td>
                <td><StatusBadge status={l.status} /></td>
                <td>{l.owner_name ?? '—'}</td>
                <td className="num">{l.opportunities}</td>
                <td className="small">{fmtDateTime(l.created_at)}<br /><span className="muted">{l.source}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
