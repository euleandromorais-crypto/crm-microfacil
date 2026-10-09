import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, withTx } from '../db/pool.js';
import { audit, diff } from '../lib/audit.js';
import { currentUser, isManager, requireRole } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { assignLead } from '../services/leads.js';
import { createResetToken, passwordSchema } from './auth.js';

const userSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  role: z.enum(['admin', 'manager', 'seller']),
  team_id: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().positive().nullable()),
  phone: z.preprocess((v) => (v === '' ? null : v), z.string().max(40).nullable().optional()),
  active: z.boolean().default(true),
  receives_leads: z.boolean().default(false),
  max_open_leads: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(1).nullable()),
  password: passwordSchema.optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => {
    const u = currentUser(req);
    const q = req.query as { active?: string };
    const rows = (
      await pool.query(
        `SELECT u.id, u.name, u.email, u.role, u.team_id, t.name AS team_name, u.phone, u.active, u.receives_leads, u.max_open_leads,
                u.last_login_at, u.last_seen_at, u.created_at,
                (SELECT count(*) FROM leads l WHERE l.owner_id=u.id AND l.deleted_at IS NULL AND l.status IN ('new','attempting','in_progress','qualified'))::int AS open_leads
           FROM users u LEFT JOIN teams t ON t.id=u.team_id
          WHERE ($1::boolean IS NULL OR u.active = $1)
          ORDER BY u.active DESC, u.name`,
        [q.active === undefined ? null : q.active === 'true'],
      )
    ).rows;
    if (isManager(u)) return rows;
    // vendedores veem apenas dados básicos (para transferências e menções)
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, team_id: r.team_id, active: r.active }));
  });

  app.post('/api/users', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(userSchema.extend({ password: passwordSchema }), req.body);
    const exists = await queryOne('SELECT id FROM users WHERE lower(email)=$1', [body.email]);
    if (exists) throw conflict('Já existe um usuário com este e-mail');
    const row = await queryOne(
      `INSERT INTO users (name, email, password_hash, role, team_id, phone, active, receives_leads, max_open_leads)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, name, email, role, team_id, active, receives_leads, max_open_leads`,
      [body.name, body.email, await bcrypt.hash(body.password, 12), body.role, body.team_id, body.phone ?? null, body.active, body.receives_leads, body.max_open_leads],
    );
    await audit({ userId: actor.id, action: 'user.create', entityType: 'user', entityId: row!.id, changes: { ...body, password: undefined }, ip: req.ip });
    return row;
  });

  app.patch('/api/users/:id', async (req) => {
    const actor = currentUser(req);
    const id = Number((req.params as any).id);
    const before = await queryOne('SELECT * FROM users WHERE id=$1', [id]);
    if (!before) throw notFound('Usuário não encontrado');
    // gestor pode ajustar distribuição de leads dos vendedores da equipe; demais alterações só o administrador
    let body: any;
    if (actor.role === 'admin') body = parse(userSchema.partial(), req.body);
    else if (actor.role === 'manager' && before.role === 'seller' && (!actor.teamId || before.team_id === actor.teamId)) {
      body = parse(z.object({ receives_leads: z.boolean().optional(), max_open_leads: userSchema.shape.max_open_leads.optional() }), req.body);
    } else requireRole(req, 'admin');
    if (id === actor.id && (body.active === false || (body.role && body.role !== 'admin' && before.role === 'admin'))) {
      throw badRequest('Você não pode desativar ou rebaixar o próprio usuário');
    }
    if (body.email && body.email !== before.email) {
      const exists = await queryOne('SELECT id FROM users WHERE lower(email)=$1 AND id<>$2', [body.email, id]);
      if (exists) throw conflict('Já existe um usuário com este e-mail');
    }
    if (before.role === 'admin' && ((body.role && body.role !== 'admin') || body.active === false)) {
      const admins = await queryOne(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1`, [id]);
      if (!admins!.n) throw badRequest('É necessário manter ao menos um administrador ativo');
    }
    const fields = ['name', 'email', 'role', 'team_id', 'phone', 'active', 'receives_leads', 'max_open_leads'].filter((k) => k in body);
    const params: unknown[] = [id, ...fields.map((f) => body[f])];
    const sets = fields.map((f, i) => `${f}=$${i + 2}`);
    if (body.password) {
      params.push(await bcrypt.hash(body.password, 12));
      sets.push(`password_hash=$${params.length}`);
    }
    if (!sets.length) return before;
    const after = await queryOne(`UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING id, name, email, role, team_id, active, receives_leads, max_open_leads`, params);
    if (body.active === false || body.password || (body.role && body.role !== before.role)) await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit({ userId: actor.id, action: 'user.update', entityType: 'user', entityId: id, changes: { ...diff(before, after!, fields), ...(body.password ? { password: 'alterada' } : {}) }, ip: req.ip });
    return after;
  });

  /** Gera link de redefinição de senha (quando não há SMTP configurado) */
  app.post('/api/users/:id/reset-link', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const user = await queryOne('SELECT id FROM users WHERE id=$1', [id]);
    if (!user) throw notFound('Usuário não encontrado');
    const link = await createResetToken(id, 24);
    await audit({ userId: actor.id, action: 'user.reset_link', entityType: 'user', entityId: id, ip: req.ip });
    return { link, expiresInHours: 24 };
  });

  /** Transfere carteira (leads abertos, oportunidades, tarefas e conversas) para outro usuário */
  app.post('/api/users/:id/transfer', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const body = parse(z.object({ to_user_id: z.coerce.number().int().positive().nullable(), only_open: z.boolean().default(true) }), req.body);
    if (body.to_user_id === id) throw badRequest('Escolha outro usuário de destino');
    const result = await withTx(async (db) => {
      const leads = (await db.query(
        `SELECT id FROM leads WHERE owner_id=$1 AND deleted_at IS NULL ${body.only_open ? `AND status IN ('new','attempting','in_progress','qualified')` : ''}`,
        [id],
      )).rows;
      for (const l of leads) await assignLead(db, l.id, body.to_user_id, actor.id, 'transfer');
      const tasks = await db.query(`UPDATE tasks SET assignee_id=$2, updated_at=now() WHERE assignee_id=$1 AND status='pending'`, [id, body.to_user_id]);
      const convs = await db.query(`UPDATE conversations SET assignee_id=$2, updated_at=now() WHERE assignee_id=$1 AND status<>'closed'`, [id, body.to_user_id]);
      const opps = await db.query(`UPDATE opportunities SET owner_id=$2, updated_at=now() WHERE owner_id=$1 AND status='open'`, [id, body.to_user_id]);
      return { leads: leads.length, tasks: tasks.rowCount, conversations: convs.rowCount, opportunities: opps.rowCount };
    });
    await audit({ userId: actor.id, action: 'user.transfer_portfolio', entityType: 'user', entityId: id, changes: { to: body.to_user_id, ...result }, ip: req.ip });
    return result;
  });

  app.patch('/api/me', async (req) => {
    const u = currentUser(req);
    const body = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), phone: z.string().max(40).nullable().optional() }), req.body);
    const row = await queryOne(`UPDATE users SET name=COALESCE($2,name), phone=COALESCE($3,phone), updated_at=now() WHERE id=$1 RETURNING id, name, email, role, phone`, [
      u.id,
      body.name ?? null,
      body.phone ?? null,
    ]);
    return row;
  });

  // Equipes
  app.get('/api/teams', async () => (await pool.query(`SELECT t.*, (SELECT count(*) FROM users u WHERE u.team_id=t.id AND u.active)::int AS members FROM teams t ORDER BY name`)).rows);
  app.post('/api/teams', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const row = await queryOne('INSERT INTO teams (name) VALUES ($1) RETURNING *', [body.name]);
    await audit({ userId: actor.id, action: 'team.create', entityType: 'team', entityId: row!.id, changes: body, ip: req.ip });
    return row;
  });
  app.patch('/api/teams/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const row = await queryOne('UPDATE teams SET name=$2 WHERE id=$1 RETURNING *', [Number((req.params as any).id), body.name]);
    if (!row) throw notFound();
    await audit({ userId: actor.id, action: 'team.update', entityType: 'team', entityId: row.id, changes: body, ip: req.ip });
    return row;
  });
  app.delete('/api/teams/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    await pool.query('DELETE FROM teams WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'team.delete', entityType: 'team', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
