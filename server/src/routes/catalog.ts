import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, withTx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { currentUser, requireRole } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { optDate, optId, optNum, optStr, parse } from '../lib/validate.js';
import { crud } from './crud.js';

const courseSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(200),
  code: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(60).regex(/^[A-Za-z0-9_.-]+$/, 'código: letras, números, ponto, _ ou -').nullable().optional()),
  kind: z.enum(['course', 'formation', 'program']).default('course'),
  category_id: optId,
  description: optStr(20000),
  modality: optStr(60),
  workload_hours: z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().int().min(0).nullable()),
  price: optNum,
  promo_price: optNum,
  promo_until: optDate,
  commercial_conditions: optStr(20000),
  seller_notes: optStr(20000),
  active: z.boolean().default(true),
  materials: z.array(z.object({ title: z.string().trim().min(1).max(200), url: z.string().trim().url('URL inválida') })).optional(),
});

export async function catalogRoutes(app: FastifyInstance) {
  crud(app, {
    path: '/api/course-categories', table: 'course_categories', entity: 'course_category', orderBy: 'name', writeRoles: ['admin', 'manager'],
    schema: z.object({ name: z.string().trim().min(1).max(120) }),
  });

  app.get('/api/courses', async (req) => {
    currentUser(req);
    const q = req.query as { active?: string; q?: string };
    return (
      await pool.query(
        `SELECT c.*, cat.name AS category_name,
                (SELECT count(*) FROM leads l WHERE l.course_id=c.id AND l.deleted_at IS NULL)::int AS interested,
                (SELECT count(*) FROM opportunities o WHERE o.course_id=c.id AND o.status='won')::int AS sales,
                (SELECT COALESCE(sum(o.sale_value),0) FROM opportunities o WHERE o.course_id=c.id AND o.status='won') AS revenue,
                (SELECT count(*) FROM opportunities o WHERE o.course_id=c.id AND o.status='open')::int AS open_opportunities
           FROM courses c LEFT JOIN course_categories cat ON cat.id=c.category_id
          WHERE ($1::boolean IS NULL OR c.active=$1) AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.code ILIKE '%' || $2 || '%')
          ORDER BY c.active DESC, c.name`,
        [q.active === undefined || q.active === '' ? null : q.active === 'true', q.q || null],
      )
    ).rows;
  });

  app.get('/api/courses/:id', async (req) => {
    currentUser(req);
    const id = Number((req.params as any).id);
    const c = await queryOne(`SELECT c.*, cat.name AS category_name FROM courses c LEFT JOIN course_categories cat ON cat.id=c.category_id WHERE c.id=$1`, [id]);
    if (!c) throw notFound('Curso não encontrado');
    const materials = (await pool.query('SELECT * FROM course_materials WHERE course_id=$1 ORDER BY id', [id])).rows;
    const stats = await queryOne(
      `SELECT (SELECT count(*) FROM leads WHERE course_id=$1 AND deleted_at IS NULL)::int AS interested,
              (SELECT count(*) FROM opportunities WHERE course_id=$1)::int AS opportunities,
              (SELECT count(*) FROM opportunities WHERE course_id=$1 AND status='open')::int AS open_opportunities,
              (SELECT count(*) FROM opportunities WHERE course_id=$1 AND status='won')::int AS sales,
              (SELECT count(*) FROM opportunities WHERE course_id=$1 AND status='lost')::int AS lost,
              (SELECT COALESCE(sum(sale_value),0) FROM opportunities WHERE course_id=$1 AND status='won') AS revenue,
              (SELECT COALESCE(avg(sale_value),0) FROM opportunities WHERE course_id=$1 AND status='won') AS avg_ticket`,
      [id],
    );
    return { ...c, materials, stats };
  });

  async function saveMaterials(db: any, courseId: number, materials?: { title: string; url: string }[]) {
    if (!materials) return;
    await db.query('DELETE FROM course_materials WHERE course_id=$1', [courseId]);
    for (const m of materials) await db.query('INSERT INTO course_materials (course_id, title, url) VALUES ($1,$2,$3)', [courseId, m.title, m.url]);
  }

  const COLS = ['name', 'code', 'kind', 'category_id', 'description', 'modality', 'workload_hours', 'price', 'promo_price', 'promo_until', 'commercial_conditions', 'seller_notes', 'active'];

  app.post('/api/courses', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const body = parse(courseSchema, req.body);
    const row = await withTx(async (db) => {
      const r = await queryOne(
        `INSERT INTO courses (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        COLS.map((c) => (body as any)[c] ?? null),
        db,
      );
      await saveMaterials(db, r!.id, body.materials);
      return r!;
    });
    await audit({ userId: actor.id, action: 'course.create', entityType: 'course', entityId: row.id, changes: body, ip: req.ip });
    return row;
  });

  app.patch('/api/courses/:id', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const before = await queryOne('SELECT * FROM courses WHERE id=$1', [id]);
    if (!before) throw notFound('Curso não encontrado');
    const body = parse(courseSchema.partial(), req.body);
    const keys = COLS.filter((c) => c in body);
    const row = await withTx(async (db) => {
      const r = keys.length
        ? await queryOne(`UPDATE courses SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...keys.map((k) => (body as any)[k] ?? null)], db)
        : before;
      await saveMaterials(db, id, body.materials);
      return r!;
    });
    await audit({ userId: actor.id, action: 'course.update', entityType: 'course', entityId: id, changes: diff(before, row, keys), ip: req.ip });
    return row;
  });

  app.delete('/api/courses/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const used = await queryOne(`SELECT (SELECT count(*) FROM leads WHERE course_id=$1) + (SELECT count(*) FROM opportunities WHERE course_id=$1) AS n`, [id]);
    if (Number(used!.n) > 0) {
      // preserva histórico: apenas inativa
      await pool.query('UPDATE courses SET active=false, updated_at=now() WHERE id=$1', [id]);
      await audit({ userId: actor.id, action: 'course.deactivate', entityType: 'course', entityId: id, ip: req.ip });
      return { ok: true, deactivated: true, message: 'O curso possui leads/oportunidades vinculados e foi apenas inativado.' };
    }
    await pool.query('DELETE FROM courses WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'course.delete', entityType: 'course', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
