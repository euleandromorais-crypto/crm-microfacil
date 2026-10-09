import type { FastifyInstance } from 'fastify';
import { queryOne } from '../db/pool.js';
import { decryptJson, hmacSha256Hex, safeEqual, sha256 } from '../lib/crypto.js';
import { enqueue } from '../lib/jobs.js';
import { logIntegration } from '../services/integrationLog.js';
import { getMetaApp } from '../services/meta/app.js';
import { verifyMetaSignature } from '../services/meta/webhook.js';

/**
 * Webhooks públicos.
 * Estratégia de confiabilidade: valida assinatura -> persiste o evento (deduplicado) -> responde 200 rapidamente ->
 * processa em segundo plano pela fila de jobs (com novas tentativas). Eventos presos são reenfileirados pela manutenção.
 */
export async function webhookRoutes(app: FastifyInstance) {
  // Verificação do endpoint (configuração do webhook no painel da Meta)
  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const metaApp = await getMetaApp();
    if (q['hub.mode'] === 'subscribe' && metaApp?.verify_token && q['hub.verify_token'] === metaApp.verify_token) {
      await logIntegration('meta', 'info', 'verify', 'Webhook verificado pela Meta');
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    await logIntegration('meta', 'warn', 'verify', 'Tentativa de verificação de webhook com token inválido');
    return reply.status(403).send('Forbidden');
  });

  app.post('/webhooks/meta', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = req.rawBody ?? '';
    const metaApp = await getMetaApp();
    if (!metaApp?.app_secret) {
      await logIntegration('meta', 'error', 'webhook', 'Evento recebido, mas o App Secret não está configurado — evento rejeitado');
      return reply.status(503).send({ error: 'not configured' });
    }
    const valid = verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, metaApp.app_secret);
    if (!valid) {
      await logIntegration('meta', 'warn', 'webhook', 'Assinatura inválida (X-Hub-Signature-256) — evento descartado');
      return reply.status(401).send({ error: 'invalid signature' });
    }
    const body = req.body as any;
    // a Meta reenvia o mesmo corpo em caso de falha: o hash do corpo deduplica
    const ins = await queryOne(
      `INSERT INTO webhook_events (provider, dedupe_key, signature_valid, payload) VALUES ('meta',$1,true,$2)
       ON CONFLICT (provider, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [sha256(raw), JSON.stringify(body ?? {})],
    );
    if (ins) await enqueue('meta.webhook', { eventId: ins.id }, { dedupeKey: `wh-${ins.id}`, maxAttempts: 10 });
    return reply.status(200).send({ ok: true });
  });

  /** Webhook genérico de entrada (formulários, ferramentas externas) */
  app.post('/webhooks/in/:token', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = (req.params as any).token as string;
    const integ = await queryOne(`SELECT * FROM integrations WHERE type='inbound_webhook' AND token=$1`, [token]);
    if (!integ) return reply.status(404).send({ error: 'not found' });
    if (!integ.active) return reply.status(410).send({ error: 'integração desativada' });
    const secrets = decryptJson<{ hmac_secret?: string }>(integ.secrets_enc);
    let signatureValid: boolean | null = null;
    if (secrets.hmac_secret) {
      const header = String(req.headers['x-signature'] ?? req.headers['x-hub-signature-256'] ?? '');
      const expected = hmacSha256Hex(secrets.hmac_secret, req.rawBody ?? '');
      signatureValid = safeEqual(header.replace(/^sha256=/, ''), expected);
      if (!signatureValid) {
        await logIntegration(`integration:${integ.id}`, 'warn', 'webhook', 'Assinatura HMAC inválida — evento descartado');
        return reply.status(401).send({ error: 'invalid signature' });
      }
    }
    const idem = (req.headers['idempotency-key'] as string | undefined) ?? (req.headers['x-idempotency-key'] as string | undefined);
    const dedupe = idem ? `key:${idem}` : `body:${sha256(req.rawBody ?? JSON.stringify(req.body ?? {}))}`;
    const ins = await queryOne(
      `INSERT INTO webhook_events (provider, dedupe_key, signature_valid, headers, payload) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [`inbound:${integ.id}`, dedupe, signatureValid, JSON.stringify({ 'user-agent': req.headers['user-agent'], origin: req.headers.origin ?? null }), JSON.stringify(req.body ?? {})],
    );
    if (ins) await enqueue('inbound.webhook', { eventId: ins.id, integrationId: integ.id }, { dedupeKey: `wh-${ins.id}` });
    return reply.status(202).send({ ok: true, duplicate: !ins, event_id: ins?.id ?? null });
  });

}
