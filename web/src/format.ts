export const TZ = 'America/Sao_Paulo';

const dtf = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts });
const fDateTime = dtf({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fDate = dtf({ day: '2-digit', month: '2-digit', year: 'numeric' });
const fTime = dtf({ hour: '2-digit', minute: '2-digit' });
const fShort = dtf({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fWeekday = dtf({ weekday: 'long', day: '2-digit', month: 'long' });

export const fmtDateTime = (d?: string | Date | null) => (d ? fDateTime.format(new Date(d)) : '—');
export const fmtDate = (d?: string | Date | null) => {
  if (!d) return '—';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }
  return fDate.format(new Date(d));
};
export const fmtTime = (d?: string | Date | null) => (d ? fTime.format(new Date(d)) : '');
export const fmtShort = (d?: string | Date | null) => (d ? fShort.format(new Date(d)) : '—');
export const fmtWeekday = (d: string | Date) => fWeekday.format(new Date(d));

/** Data local (America/Sao_Paulo) AAAA-MM-DD */
export function localDate(d: Date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Converte data+hora locais (São Paulo) em ISO UTC */
export function localToIso(date: string, time: string) {
  // calcula o deslocamento de São Paulo para a data (atualmente -03:00, sem horário de verão)
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offset = asLocal - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}
/** ISO -> {date, time} locais */
export function isoToLocal(iso: string) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlShort = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
export const money = (v?: number | string | null) => (v === null || v === undefined || v === '' ? '—' : brl.format(Number(v)));
export const moneyShort = (v?: number | null) => (v === null || v === undefined ? '—' : brlShort.format(Number(v)));
export const num = (v?: number | null) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('pt-BR').format(v));
export const pct = (v?: number | null) => (v === null || v === undefined ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

export function duration(seconds?: number | null) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}min` : ''}`;
  return `${Math.round(h / 24)} dias`;
}

export function relative(d?: string | Date | null) {
  if (!d) return '—';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const abs = Math.abs(diff);
  const fut = diff < 0;
  let out: string;
  if (abs < 60) out = 'agora';
  else if (abs < 3600) out = `${Math.round(abs / 60)} min`;
  else if (abs < 86400) out = `${Math.round(abs / 3600)} h`;
  else if (abs < 86400 * 30) out = `${Math.round(abs / 86400)} d`;
  else return fmtDate(d);
  if (out === 'agora') return out;
  return fut ? `em ${out}` : `há ${out}`;
}

export function fmtPhone(p?: string | null) {
  if (!p) return '';
  if (p.startsWith('55') && (p.length === 12 || p.length === 13)) {
    const n = p.slice(4);
    return `(${p.slice(2, 4)}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return `+${p}`;
}

export const STATUS_LABELS: Record<string, string> = {
  new: 'Novo', attempting: 'Tentando contato', in_progress: 'Em atendimento', qualified: 'Qualificado',
  customer: 'Matriculado', lost: 'Perdido', unqualified: 'Desqualificado',
};
export const STATUS_COLORS: Record<string, string> = {
  new: 'blue', attempting: 'amber', in_progress: 'indigo', qualified: 'violet', customer: 'green', lost: 'red', unqualified: 'gray',
};
export const TASK_TYPES: Record<string, string> = {
  call: 'Ligação', whatsapp: 'Mensagem WhatsApp', meeting: 'Reunião', visit: 'Visita', task: 'Tarefa', followup: 'Acompanhamento',
  reminder: 'Lembrete', first_contact: 'Primeiro contato',
};
export const TASK_ICONS: Record<string, string> = {
  call: '📞', whatsapp: '💬', meeting: '👥', visit: '🏫', task: '✔️', followup: '🔁', reminder: '⏰', first_contact: '⚡',
};
export const ROLE_LABELS: Record<string, string> = { admin: 'Administrador', manager: 'Gestor comercial', seller: 'Vendedor' };
export const KIND_LABELS: Record<string, string> = { course: 'Curso', formation: 'Formação', program: 'Programa' };
