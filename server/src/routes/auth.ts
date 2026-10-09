import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, isTest } from '../config.js';
import { pool, queryOne } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { createSession, currentUser, destroySession, SESSION_COOKIE, setSessionCookie } from '../lib/auth.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { mailEnabled, sendMail } from '../lib/mailer.js';
import { parse } from '../lib/validate.js';

export const passwordSchema = z
  .string()
  .min(8, 'A senha deve ter ao menos 8 caracteres')
  .max(200)
  .refine((s) => /[A-Za-z]/.test(s) && /\d/.test(s), 'A senha deve conter letras e números');

const MAX_FAILED = 5;
// hash fixo para comparar mesmo quando o usuário não existe (tempo de resposta uniforme)
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', 10);
const LOCK_MINUTES = 15;

export async function createResetToken(userId: number, hours = 2) {
  const token = randomToken(32);
  await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3::int))`, [userId, sha256(token), hours]);
  return `${config.APP_URL.replace(/\/$/, '')}/redefinir-senha?token=${token}`;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { rateLimit: { max: isTest ? 1000 : 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }), req.body);
    const user = await queryOne('SELECT * FROM users WHERE lower(email)=$1', [body.email]);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      throw unauthorized(`Acesso temporariamente bloqueado por excesso de tentativas. Tente novamente após ${LOCK_MINUTES} minutos.`);
    }
    const ok = user ? await bcrypt.compare(body.password, user.password_hash) : await bcrypt.compare(body.password, DUMMY_HASH);
    if (!user || !ok || !user.active) {
      if (user) {
        const failed = user.failed_logins + 1;
        const lock = failed >= MAX_FAILED;
        await pool.query(
          `UPDATE users SET failed_logins=$2, locked_until=CASE WHEN $3 THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE id=$1`,
          [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
        );
        await audit({ userId: user.id, action: 'auth.login_failed', ip: req.ip });
      }
      throw unauthorized(user && !user.active && ok ? 'Usuário desativado. Procure o administrador.' : 'E-mail ou senha inválidos');
    }
    await pool.query('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [user.id]);
    const { token, expires } = await createSession(user.id, req.ip, req.headers['user-agent']);
    setSessionCookie(reply, token, expires);
    await audit({ userId: user.id, action: 'auth.login', ip: req.ip });
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role, teamId: user.team_id } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await audit({ userId: req.user?.id, action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = currentUser(req);
    const extra = await queryOne('SELECT phone, receives_leads FROM users WHERE id=$1', [u.id]);
    return { user: { ...u, ...extra }, mailEnabled: mailEnabled() };
  });

  app.post('/api/auth/password', async (req) => {
    const u = currentUser(req);
    const body = parse(z.object({ current: z.string().min(1), password: passwordSchema }), req.body);
    const row = await queryOne('SELECT password_hash FROM users WHERE id=$1', [u.id]);
    if (!(await bcrypt.compare(body.current, row!.password_hash))) throw badRequest('Senha atual incorreta');
    await pool.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [u.id, await bcrypt.hash(body.password, 12)]);
    // encerra as demais sessões
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND id <> $2', [u.id, sha256(req.cookies[SESSION_COOKIE] ?? '')]);
    await audit({ userId: u.id, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/forgot', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase() }), req.body);
    const user = await queryOne('SELECT id, name, email FROM users WHERE lower(email)=$1 AND active', [body.email]);
    // resposta idêntica exista ou não o e-mail (evita enumeração de usuários)
    if (user && mailEnabled()) {
      const link = await createResetToken(user.id);
      await sendMail(
        user.email,
        'Redefinição de senha — CRM',
        `Olá, ${user.name}.\n\nPara redefinir sua senha, acesse: ${link}\n\nO link expira em 2 horas. Se você não solicitou, ignore este e-mail.`,
      ).catch((err) => req.log.error({ err }, 'falha ao enviar e-mail de redefinição'));
      await audit({ userId: user.id, action: 'auth.reset_requested', ip: req.ip });
    }
    return {
      ok: true,
      message: mailEnabled()
        ? 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.'
        : 'O envio de e-mails não está configurado. Solicite ao administrador um link de redefinição.',
    };
  });

  app.post('/api/auth/reset', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10), password: passwordSchema }), req.body);
    const row = await queryOne(`SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`, [sha256(body.token)]);
    if (!row) throw badRequest('Link inválido ou expirado. Solicite uma nova redefinição.');
    await pool.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1', [row.user_id, await bcrypt.hash(body.password, 12)]);
    await pool.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [row.id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
    await audit({ userId: row.user_id, action: 'auth.password_reset', ip: req.ip });
    return { ok: true };
  });
}
