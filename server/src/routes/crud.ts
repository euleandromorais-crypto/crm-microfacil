import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { currentUser, requireRole, Role } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

interface CrudOptions {
  path: string;
  table: string;
  schema: z.ZodObject<any>;
  writeRoles: Role[];
  orderBy: string;
  entity: string;
  /** colunas jsonb (serializadas antes de gravar) */
  jsonColumns?: string[];
  listSql?: string;
}

/** Rotas CRUD padronizadas para tabelas de configuração simples */
export function crud(app: FastifyInstance, o: CrudOptions) {
  const ser = (k: string, v: unknown) => (o.jsonColumns?.includes(k) ? JSON.stringify(v ?? null) : v);

  app.get(o.path, async (req) => {
    currentUser(req);
    return (await pool.query(o.listSql ?? `SELECT * FROM ${o.table} ORDER BY ${o.orderBy}`)).rows;
  });

  app.post(o.path, async (req) => {
    const actor = requireRole(req, ...o.writeRoles);
    const body = parse(o.schema, req.body) as Record<string, unknown>;
    const keys = Object.keys(body);
    const row = await queryOne(
      `INSERT INTO ${o.table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => ser(k, body[k])),
    );
    await audit({ userId: actor.id, action: `${o.entity}.create`, entityType: o.entity, entityId: row!.id, changes: body, ip: req.ip });
    return row;
  });

  app.patch(`${o.path}/:id`, async (req) => {
    const actor = requireRole(req, ...o.writeRoles);
    const id = Number((req.params as any).id);
    const before = await queryOne(`SELECT * FROM ${o.table} WHERE id=$1`, [id]);
    if (!before) throw notFound();
    const body = parse(o.schema.partial(), req.body) as Record<string, unknown>;
    const keys = Object.keys(body).filter((k) => body[k] !== undefined);
    if (!keys.length) return before;
    const hasUpdatedAt = 'updated_at' in before;
    const row = await queryOne(
      `UPDATE ${o.table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}${hasUpdatedAt ? ', updated_at=now()' : ''} WHERE id=$1 RETURNING *`,
      [id, ...keys.map((k) => ser(k, body[k]))],
    );
    await audit({ userId: actor.id, action: `${o.entity}.update`, entityType: o.entity, entityId: id, changes: diff(before, row!, keys), ip: req.ip });
    return row;
  });

  app.delete(`${o.path}/:id`, async (req) => {
    const actor = requireRole(req, ...o.writeRoles);
    const id = Number((req.params as any).id);
    const before = await queryOne(`SELECT * FROM ${o.table} WHERE id=$1`, [id]);
    if (!before) throw notFound();
    await pool.query(`DELETE FROM ${o.table} WHERE id=$1`, [id]);
    await audit({ userId: actor.id, action: `${o.entity}.delete`, entityType: o.entity, entityId: id, changes: before, ip: req.ip });
    return { ok: true };
  });
}
