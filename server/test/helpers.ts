import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { createServer, IncomingMessage, Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { ensureDefaults } from '../src/db/defaults.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { hmacSha256Hex } from '../src/lib/crypto.js';
import { runDueJobs } from '../src/lib/jobs.js';
import { registerAllJobs } from '../src/services/scheduler.js';

let app: FastifyInstance | null = null;

export async function getApp() {
  if (!app) {
    await migrate(() => {});
    await ensureDefaults();
    registerAllJobs();
    app = await buildApp();
    await app.ready();
  }
  return app;
}

/** Limpa dados entre suítes, mantendo a estrutura e a configuração padrão */
export async function resetData() {
  await pool.query(`TRUNCATE leads, opportunities, tasks, conversations, messages, users, teams, notifications, jobs, webhook_events, integrations,
    wa_accounts, wa_templates, api_keys, automation_runs, campaigns, courses, audit_logs, lead_events, settings, idempotency_keys, tags, integration_logs RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM automation_rules`);
}

export async function createUser(name: string, role: 'admin' | 'manager' | 'seller', opts: { receives_leads?: boolean; team_id?: number | null } = {}) {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@teste.com`;
  const r = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, receives_leads, team_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, email, await bcrypt.hash('Senha1234', 4), role, opts.receives_leads ?? role === 'seller', opts.team_id ?? null],
  );
  return { id: r.rows[0].id as number, email, password: 'Senha1234' };
}

/** Cliente autenticado (cookie de sessão + cabeçalho anti-CSRF) */
export async function login(email: string, password = 'Senha1234') {
  const a = await getApp();
  const res = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login falhou: ${res.body}`);
  const cookie = res.headers['set-cookie'] as string;
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await a.inject({ method, url, payload: payload as any, headers: { cookie: cookie.split(';')[0], 'x-requested-with': 'crm' } });
    let body: any = r.body;
    try {
      body = JSON.parse(r.body);
    } catch {
      /* não-JSON */
    }
    return { status: r.statusCode, body, headers: r.headers };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
    patch: (url: string, body?: unknown) => call('PATCH', url, body ?? {}),
    put: (url: string, body?: unknown) => call('PUT', url, body ?? {}),
    del: (url: string) => call('DELETE', url),
    cookie,
  };
}

/** Processa toda a fila de jobs (equivalente ao worker) */
export async function drainJobs(maxRounds = 20) {
  for (let i = 0; i < maxRounds; i++) {
    const n = await runDueJobs(50);
    if (!n) {
      // re-tentativas agendadas para o futuro: antecipa para executar já
      const r = await pool.query(`UPDATE jobs SET run_at=now() WHERE status='pending' AND run_at > now() AND attempts > 0 RETURNING id`);
      if (!r.rowCount) return;
    }
  }
}

// ---------------------------------------------------------------- Graph API falsa
export interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth?: string;
}

export class FakeGraph {
  calls: GraphCall[] = [];
  server: Server;
  /** respostas customizadas por "METHOD path" */
  handlers = new Map<string, (c: GraphCall) => { status?: number; json: any }>();
  private seq = 0;
  constructor(public port = 47011) {
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      const path = url.pathname.replace(/^\/v[\d.]+\//, '');
      const call: GraphCall = { method: req.method!, path, query: url.searchParams, body, auth: req.headers.authorization };
      this.calls.push(call);
      const h = this.handlers.get(`${req.method} ${path}`) ?? this.defaultHandler(call);
      const out = h ? h(call) : { status: 404, json: { error: { message: `rota falsa inexistente: ${req.method} ${path}`, code: 100 } } };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  }
  private defaultHandler(c: GraphCall): ((c: GraphCall) => { status?: number; json: any }) | undefined {
    if (c.method === 'POST' && c.path.endsWith('/messages')) return () => ({ json: { messaging_product: 'whatsapp', contacts: [{ wa_id: c.body?.to }], messages: [{ id: `wamid.OUT${++this.seq}` }] } });
    if (c.method === 'POST' && c.path.endsWith('/media')) return () => ({ json: { id: `media-${++this.seq}` } });
    if (c.method === 'POST' && c.path.endsWith('/subscribed_apps')) return () => ({ json: { success: true } });
    if (c.method === 'GET' && c.path.endsWith('/subscribed_apps')) return () => ({ json: { data: [{ id: '1' }] } });
    if (c.method === 'GET' && /^\d+$/.test(c.path)) return () => ({ json: { id: c.path, display_phone_number: '+55 11 4000-0000', verified_name: 'Micro Fácil', quality_rating: 'GREEN' } });
    if (c.method === 'GET' && c.path.endsWith('/message_templates')) {
      return () => ({ json: { data: [{ id: 't1', name: 'retomar_contato', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Olá {{1}}, ainda tem interesse no curso?' }] }] } });
    }
    return undefined;
  }
  start() {
    return new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', () => r()));
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

function readBody(req: IncomingMessage) {
  return new Promise<any>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

/** Envia um webhook da Meta assinado com o App Secret */
export async function postMetaWebhook(payload: unknown, appSecret: string, signatureOverride?: string) {
  const a = await getApp();
  const raw = JSON.stringify(payload);
  return a.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signatureOverride ?? `sha256=${hmacSha256Hex(appSecret, raw)}` },
  });
}

export function waMessagePayload(phoneNumberId: string, msgs: any[], contacts: any[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '551140000000', phone_number_id: phoneNumberId }, contacts, messages: msgs } }] }],
  };
}

export function waStatusPayload(phoneNumberId: string, statuses: any[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, statuses } }] }],
  };
}
