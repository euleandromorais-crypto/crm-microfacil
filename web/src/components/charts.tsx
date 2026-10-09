import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money, num } from '../format';

/** Paleta categórica validada (ordem fixa; nunca reciclar cores) */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const AXIS = { fontSize: 11, fill: '#64748b' };
const GRID = '#e8edf3';

const fmtBucket = (b: string, g?: string) => {
  const [y, m, d] = b.split('-');
  if (g === 'month') return `${m}/${y.slice(2)}`;
  return `${d}/${m}`;
};

function TooltipBox({ active, payload, label, granularity, format }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card" style={{ padding: '8px 10px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{granularity === 'week' ? 'Semana de ' : ''}{label?.split('-').reverse().join('/')}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="row" style={{ gap: 6 }}>
          <span className="dot" style={{ background: p.color }} />
          <span className="muted">{p.name}:</span> <b>{format === 'money' ? money(p.value) : num(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Série temporal com até 3 séries na MESMA unidade (nunca eixo duplo) */
export function TimeLines({ data, series, granularity, format, height = 240 }: { data: any[]; series: { key: string; name: string }[]; granularity?: string; format?: 'money'; height?: number }) {
  return (
    <div>
      {series.length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {series.map((s, i) => (
            <span key={s.key} className="row" style={{ gap: 5 }}><span className="dot" style={{ background: SERIES[i] }} />{s.name}</span>
          ))}
        </div>
      )}
      <div style={{ height }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="bucket" tick={AXIS} tickFormatter={(b) => fmtBucket(b, granularity)} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={format === 'money' ? 70 : 36} allowDecimals={false}
              tickFormatter={(v) => (format === 'money' ? new Intl.NumberFormat('pt-BR', { notation: 'compact', style: 'currency', currency: 'BRL' }).format(v) : num(v))} />
            <Tooltip content={<TooltipBox granularity={granularity} format={format} />} cursor={{ stroke: '#94a3b8', strokeDasharray: '3 3' }} />
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function TimeBars({ data, dataKey, name, granularity, format, height = 240 }: { data: any[]; dataKey: string; name: string; granularity?: string; format?: 'money'; height?: number }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="bucket" tick={AXIS} tickFormatter={(b) => fmtBucket(b, granularity)} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={format === 'money' ? 70 : 36} allowDecimals={false}
            tickFormatter={(v) => (format === 'money' ? new Intl.NumberFormat('pt-BR', { notation: 'compact', style: 'currency', currency: 'BRL' }).format(v) : num(v))} />
          <Tooltip content={<TooltipBox granularity={granularity} format={format} />} cursor={{ fill: 'rgba(148,163,184,.15)' }} />
          <Bar dataKey={dataKey} name={name} fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Lista com barras horizontais (ranking) — valores sempre visíveis em texto */
export function BarList({ items, format, empty = 'Sem dados no período' }: { items: { label: string; value: number; sub?: string }[]; format?: 'money'; empty?: string }) {
  if (!items.length) return <div className="muted small" style={{ padding: 8 }}>{empty}</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="bar-list">
      {items.map((i) => (
        <div className="item" key={i.label} title={`${i.label}: ${format === 'money' ? money(i.value) : num(i.value)}`}>
          <span className="ellipsis">{i.label}{i.sub && <span className="muted small"> · {i.sub}</span>}</span>
          <b>{format === 'money' ? money(i.value) : num(i.value)}</b>
          <div className="bar"><span style={{ width: `${(i.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}
