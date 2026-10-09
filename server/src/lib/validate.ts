import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    const first = r.error.issues[0];
    throw badRequest(`Dados inválidos: ${first.path.join('.') || 'requisição'} — ${first.message}`, { fields });
  }
  return r.data;
}

export const id = z.coerce.number().int().positive();
export const optId = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().int().positive().nullable());
export const optStr = (max = 500) =>
  z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v ?? null), z.string().max(max).nullable());
export const optNum = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().nullable());
export const optDate = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida (AAAA-MM-DD)').nullable(),
);
export const optDateTime = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'data/hora inválida').nullable(),
);
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Lista de IDs vinda da query string: "1,2,3" ou array */
export const idList = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(Number);
  return String(v).split(',').filter(Boolean).map(Number);
}, z.array(z.number().int().positive()).optional());
