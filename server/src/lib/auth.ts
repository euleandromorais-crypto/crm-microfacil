import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool, queryOne, Sql } from '../db/pool.js';
import { randomToken, sha256 } from './crypto.js';
import { forbidden, notFound, unauthorized } from './errors.js';

export type Role = 'admin' | 'manager' | 'seller';
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  teamId: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    rawBody?: string;
  }
}

export const SESSION_COOKIE = 'crm_session';

export async function createSession(userId: number, ip?: string, ua?: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
  await pool.query(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`, [
    sha256(token),
    userId,
    expires,
    ip ?? null,
    ua?.slice(0, 300) ?? null,
  ]);
  return { token, expires };
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    expires,
  });
}

export async function destroySession(token?: string) {
  if (token) await pool.query('DELETE FROM sessions WHERE id=$1', [sha256(token)]);
}

export async function userFromToken(token?: string): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await queryOne(
    `SELECT u.id, u.name, u.email, u.role, u.team_id, s.last_used_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  if (!row) return null;
  // atualiza "visto por último" no máximo a cada minuto (evita escrita por requisição)
  if (Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    const id = sha256(token);
    pool.query('UPDATE sessions SET last_used_at=now() WHERE id=$1', [id]).catch(() => {});
    pool.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [row.id]).catch(() => {});
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, teamId: row.team_id };
}

export async function authenticate(req: FastifyRequest) {
  const user = await userFromToken(req.cookies?.[SESSION_COOKIE]);
  if (!user) throw unauthorized();
  req.user = user;
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]) {
  const u = currentUser(req);
  if (!roles.includes(u.role)) throw forbidden();
  return u;
}

export const isManager = (u: AuthUser) => u.role === 'admin' || u.role === 'manager';

// ------------------------------------------------------------------
// Restrição de dados por perfil (aplicada em todas as consultas no servidor)
// ------------------------------------------------------------------

let seeUnassignedCache: { v: boolean; at: number } | null = null;
export async function sellersSeeUnassigned() {
  if (seeUnassignedCache && Date.now() - seeUnassignedCache.at < 30_000) return seeUnassignedCache.v;
  const row = await queryOne(`SELECT value FROM settings WHERE key='general'`);
  const v = !!row?.value?.sellers_see_unassigned;
  seeUnassignedCache = { v, at: Date.now() };
  return v;
}
export function invalidateSettingsCache() {
  seeUnassignedCache = null;
}

/**
 * Cláusula SQL que restringe leads visíveis ao usuário.
 * - admin: todos
 * - gestor: leads da própria equipe + sem responsável (todos se não tiver equipe)
 * - vendedor: leads sob sua responsabilidade ou com conversa atribuída a ele (+ sem responsável, se configurado)
 */
export async function leadScope(user: AuthUser, sql: Sql, alias = 'l'): Promise<string> {
  if (user.role === 'admin') return 'TRUE';
  if (user.role === 'manager') {
    if (!user.teamId) return 'TRUE';
    return `(${alias}.owner_id IS NULL OR ${alias}.owner_id IN (SELECT id FROM users WHERE team_id = ${sql.p(user.teamId)}) OR ${alias}.owner_id = ${sql.p(user.id)})`;
  }
  const me = sql.p(user.id);
  const unassigned = (await sellersSeeUnassigned()) ? ` OR ${alias}.owner_id IS NULL` : '';
  return `(${alias}.owner_id = ${me} OR EXISTS (SELECT 1 FROM conversations c_s WHERE c_s.lead_id = ${alias}.id AND c_s.assignee_id = ${me})${unassigned})`;
}

/** Restrição para registros com coluna de responsável (oportunidades, tarefas) */
export function ownerScope(user: AuthUser, sql: Sql, column: string): string {
  if (user.role === 'admin') return 'TRUE';
  if (user.role === 'manager') {
    if (!user.teamId) return 'TRUE';
    return `(${column} IS NULL OR ${column} IN (SELECT id FROM users WHERE team_id = ${sql.p(user.teamId)}) OR ${column} = ${sql.p(user.id)})`;
  }
  return `${column} = ${sql.p(user.id)}`;
}

/** Restrição para conversas */
export async function conversationScope(user: AuthUser, sql: Sql, alias = 'c'): Promise<string> {
  if (user.role === 'admin') return 'TRUE';
  if (user.role === 'manager') {
    if (!user.teamId) return 'TRUE';
    const t = sql.p(user.teamId);
    return `(${alias}.assignee_id IS NULL OR ${alias}.assignee_id IN (SELECT id FROM users WHERE team_id = ${t}) OR ${alias}.assignee_id = ${sql.p(user.id)})`;
  }
  const me = sql.p(user.id);
  const unassigned = (await sellersSeeUnassigned()) ? ` OR (${alias}.assignee_id IS NULL)` : '';
  return `(${alias}.assignee_id = ${me} OR (${alias}.assignee_id IS NULL AND EXISTS (SELECT 1 FROM leads l_s WHERE l_s.id = ${alias}.lead_id AND l_s.owner_id = ${me}))${unassigned})`;
}

/** Usuários cujos dados o usuário pode ver (para filtros por vendedor) */
export async function visibleUserIds(user: AuthUser): Promise<number[] | null> {
  if (user.role === 'admin' || (user.role === 'manager' && !user.teamId)) return null; // todos
  if (user.role === 'manager') {
    const rows = (await pool.query('SELECT id FROM users WHERE team_id=$1 OR id=$2', [user.teamId, user.id])).rows;
    return rows.map((r) => r.id);
  }
  return [user.id];
}

export async function assertLeadAccess(user: AuthUser, leadId: number) {
  const sql = new Sql([leadId]);
  const scope = await leadScope(user, sql);
  const row = await queryOne(`SELECT l.id FROM leads l WHERE l.id = $1 AND l.deleted_at IS NULL AND ${scope}`, sql.params);
  if (!row) {
    const exists = await queryOne('SELECT id FROM leads WHERE id=$1 AND deleted_at IS NULL', [leadId]);
    throw exists ? forbidden('Você não tem acesso a este lead') : notFound('Lead não encontrado');
  }
}
