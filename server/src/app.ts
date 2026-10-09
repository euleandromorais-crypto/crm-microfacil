import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config, isTest } from './config.js';
import { pool } from './db/pool.js';
import { authenticate } from './lib/auth.js';
import { AppError } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';

const PUBLIC_API = ['/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/health', '/api/public/'];

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest ? false : { level: config.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-api-key"]'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  // guarda o corpo bruto (necessário para validar assinaturas de webhooks)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new AppError(400, 'JSON inválido', 'bad_json');
      done(err, undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://connect.facebook.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'https://graph.facebook.com', 'https://www.facebook.com'],
        frameSrc: ["'self'", 'https://www.facebook.com', 'https://web.facebook.com'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.COOKIE_SECURE ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: `Dados inválidos: ${first.path.join('.')} — ${first.message}`, code: 'bad_request' });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: 'Muitas requisições. Aguarde um instante e tente novamente.', code: 'rate_limited' });
    if (err.statusCode && err.statusCode < 500) {
      const msg = err.code === 'FST_REQ_FILE_TOO_LARGE' ? `Arquivo excede o limite de ${config.MAX_UPLOAD_MB} MB` : err.message;
      return reply.status(err.statusCode).send({ error: msg, code: err.code ?? 'error' });
    }
    // violações de unicidade do banco viram 409 com mensagem amigável
    if (err.code === '23505') return reply.status(409).send({ error: 'Registro duplicado: já existe um item com esses dados.', code: 'duplicate' });
    if (err.code === '23503') return reply.status(409).send({ error: 'Operação não permitida: o registro está vinculado a outros dados.', code: 'fk_violation' });
    req.log.error({ err }, 'erro interno');
    return reply.status(500).send({ error: 'Erro interno. A falha foi registrada; tente novamente.', code: 'internal' });
  });

  // autenticação + proteção CSRF (exige cabeçalho customizado em requisições que alteram dados)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (PUBLIC_API.some((p) => url === p || (p.endsWith('/') && url.startsWith(p)))) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'crm') {
      return reply.status(403).send({ error: 'Requisição bloqueada (CSRF)', code: 'csrf' });
    }
    await authenticate(req);
  });

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  await registerRoutes(app);

  // SPA (frontend compilado)
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [resolve(here, '../../web/dist'), resolve(here, '../web/dist')].find((p) => existsSync(join(p, 'index.html')));
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: true, maxAge: '1h', setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
      else if (path.includes('/assets/')) res.header('Cache-Control', 'public, max-age=31536000, immutable');
    } });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/webhooks/') || req.url.startsWith('/assets/')) return reply.status(404).send({ error: 'Rota não encontrada' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
