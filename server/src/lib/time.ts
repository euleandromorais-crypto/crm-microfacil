import { APP_TZ } from '../config.js';

/** Data local (America/Sao_Paulo) no formato YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** Período anterior de mesma duração (para comparativos) */
export function previousPeriod(from: string, to: string) {
  const len = diffDays(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export function formatDateTimeBR(d: Date | string | null | undefined) {
  if (!d) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: APP_TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));
}
