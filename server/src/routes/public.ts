import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool, queryOne } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { logIntegration } from '../services/integrationLog.js';
import { intakeLead } from '../services/leads.js';

const leadSchema = z.object({
  name: z.string().trim().max(200).optional(),
  nome: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  telefone: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  email: z.string().trim().max(200).optional(),
  course: z.string().trim().max(200).optional(),
  curso: z.string().trim().max(200).optional(),
  course_id: z.coerce.number().int().optional(),
  source: z.string().trim().max(80).optional(),
  campaign: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(60).optional(),
  message: z.string().trim().max(5000).optional(),
  mensagem: z.string().trim().max(5000).optional(),
  utm_source: z.string().trim().max(200).optional(),
  utm_medium: z.string().trim().max(200).optional(),
  utm_campaign: z.string().trim().max(200).optional(),
  utm_term: z.string().trim().max(200).optional(),
  utm_content: z.string().trim().max(200).optional(),
  page_url: z.string().trim().max(1000).optional(),
  external_id: z.string().trim().max(200).optional(),
  consent: z.union([z.boolean(), z.string()]).optional(),
  custom: z.record(z.string(), z.any()).optional(),
  // honeypot anti-spam: deve vir vazio
  website: z.string().optional(),
});

async function authKey(req: FastifyRequest) {
  const key = (req.headers['x-api-key'] as string | undefined) ?? (req.query as any)?.key ?? (req.body as any)?.api_key;
  if (!key) throw new AppError(401, 'Chave de API ausente (cabeçalho X-Api-Key)', 'unauthorized');
  const row = await queryOne(`SELECT * FROM api_keys WHERE key_hash=$1 AND active`, [sha256(String(key))]);
  if (!row) throw new AppError(401, 'Chave de API inválida ou desativada', 'unauthorized');
  const origin = req.headers.origin;
  if (origin && row.allowed_origins?.length && !row.allowed_origins.includes(origin)) {
    throw new AppError(403, 'Origem não autorizada para esta chave', 'forbidden');
  }
  pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.id]).catch(() => {});
  return row;
}

function cors(req: FastifyRequest, reply: FastifyReply) {
  const origin = req.headers.origin;
  if (origin) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Idempotency-Key');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Max-Age', '600');
  }
}

/** API pública de captação de leads (landing pages, formulários e ferramentas externas) */
export async function publicRoutes(app: FastifyInstance) {
  app.options('/api/public/leads', async (req, reply) => {
    cors(req, reply);
    return reply.status(204).send();
  });

  app.post('/api/public/leads', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    cors(req, reply);
    const key = await authKey(req);
    const body = parse(leadSchema.passthrough(), req.body ?? {});
    if (body.website) return { ok: true }; // bot preencheu o honeypot: aceita silenciosamente
    const idem = (req.headers['idempotency-key'] as string | undefined) ?? body.external_id;
    if (idem) {
      const prev = await queryOne('SELECT response FROM idempotency_keys WHERE scope=$1 AND key=$2', [`api:${key.id}`, idem]);
      if (prev) return { ...prev.response, duplicate: true };
    }
    const phone = body.phone ?? body.telefone ?? body.whatsapp;
    if (!phone && !body.email) throw badRequest('Informe telefone ou e-mail');
    const known = new Set(Object.keys(leadSchema.shape).concat(['api_key']));
    const extra = Object.fromEntries(Object.entries(body).filter(([k, v]) => !known.has(k) && typeof v !== 'object'));
    try {
      const r = await intakeLead(
        {
          name: body.name ?? body.nome,
          phone,
          email: body.email,
          course: body.course ?? body.curso,
          course_id: body.course_id ?? (body.course || body.curso ? undefined : key.default_course_id ?? undefined),
          source: body.source ?? key.default_source ?? key.name,
          campaign: body.campaign,
          city: body.city,
          state: body.state,
          message: body.message ?? body.mensagem,
          utm_source: body.utm_source,
          utm_medium: body.utm_medium,
          utm_campaign: body.utm_campaign,
          utm_term: body.utm_term,
          utm_content: body.utm_content,
          referrer_url: body.page_url,
          external_ref: body.external_id,
          consent_whatsapp: body.consent === true || body.consent === 'true' || body.consent === 'on' || body.consent === '1',
          custom: body.custom,
          extra,
        },
        `api:${key.id}`,
      );
      const response = { ok: true, lead_id: r.leadId, created: r.created };
      if (idem) await pool.query('INSERT INTO idempotency_keys (scope, key, response) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [`api:${key.id}`, idem, JSON.stringify(response)]);
      await logIntegration(`api_key:${key.id}`, 'info', 'lead', `Lead #${r.leadId} ${r.created ? 'criado' : 'atualizado'} via API (${key.name})`);
      return reply.status(r.created ? 201 : 200).send(response);
    } catch (err) {
      await logIntegration(`api_key:${key.id}`, 'error', 'lead', `Falha ao receber lead via API: ${(err as Error).message}`);
      throw err;
    }
  });
}
