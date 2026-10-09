import { useAuth } from '../auth';
import { addDays, localDate } from '../format';
import { useCampaigns, useCourses, useUsers } from '../hooks';
import { Field } from './ui';

export interface PeriodFilters {
  preset: string;
  from: string;
  to: string;
  owner_id: string;
  course_id: string;
  campaign_id: string;
}

export const defaultFilters: PeriodFilters = { preset: '30d', from: '', to: '', owner_id: '', course_id: '', campaign_id: '' };

/** Converte o preset em datas locais (America/Sao_Paulo) */
export function resolvePeriod(f: PeriodFilters) {
  const today = localDate();
  switch (f.preset) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastmonth': {
      const first = `${today.slice(0, 7)}-01`;
      const lastEnd = addDays(first, -1);
      return { from: `${lastEnd.slice(0, 7)}-01`, to: lastEnd };
    }
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom':
      return { from: f.from || addDays(today, -29), to: f.to || today };
    default:
      return { from: addDays(today, -29), to: today };
  }
}

export function FilterBar({ value, onChange, extra }: { value: PeriodFilters; onChange: (f: PeriodFilters) => void; extra?: React.ReactNode }) {
  const { isManager } = useAuth();
  const { data: users } = useUsers();
  const { data: courses } = useCourses();
  const { data: campaigns } = useCampaigns();
  const set = (k: keyof PeriodFilters, v: string) => onChange({ ...value, [k]: v });
  const period = resolvePeriod(value);
  return (
    <div className="filters card card-pad" style={{ padding: 12 }}>
      <Field label="Período">
        <select className="select" value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value, ...(e.target.value === 'custom' ? period : {}) })}>
          <option value="today">Hoje</option>
          <option value="7d">Últimos 7 dias</option>
          <option value="30d">Últimos 30 dias</option>
          <option value="month">Este mês</option>
          <option value="lastmonth">Mês passado</option>
          <option value="90d">Últimos 90 dias</option>
          <option value="year">Este ano</option>
          <option value="custom">Personalizado</option>
        </select>
      </Field>
      {value.preset === 'custom' && (
        <>
          <Field label="De"><input className="input" type="date" value={value.from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="Até"><input className="input" type="date" value={value.to} onChange={(e) => set('to', e.target.value)} /></Field>
        </>
      )}
      {isManager && (
        <Field label="Vendedor">
          <select className="select" value={value.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
            <option value="">Todos</option>
            {users?.filter((u) => u.role !== 'admin' || u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Curso">
        <select className="select" value={value.course_id} onChange={(e) => set('course_id', e.target.value)}>
          <option value="">Todos</option>
          {courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Campanha">
        <select className="select" value={value.campaign_id} onChange={(e) => set('campaign_id', e.target.value)}>
          <option value="">Todas</option>
          {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {extra}
      <span className="small muted" style={{ alignSelf: 'center' }}>{period.from.split('-').reverse().join('/')} a {period.to.split('-').reverse().join('/')}</span>
    </div>
  );
}
