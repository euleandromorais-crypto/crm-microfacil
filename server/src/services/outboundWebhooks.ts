import { pool, queryOne } from '../db/pool.js';
import { decryptJson, hmacSha256Hex } from '../lib/crypto.js';
import { enqueue } from '../lib/jobs.js';
import { logIntegration } from './integrationLog.js';

/** Monta o payload público de um evento (dados mínimos necessários — princípio da minimização da LGPD) */
async function buildEventPayload(event: any) {
  const lead = event.leadId
    ? await queryOne(
        `SELECT l.id, l.name, l.phone, l.email, l.status, l.source, l.utm_source, l.utm_medium, l.utm_campaign, l.created_at,
                c.name AS course, u.name AS owner, cp.name AS campaign
           FROM leads l LEFT JOIN courses c ON c.id=l.course_id LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN campaigns cp ON cp.id=l.campaign_id
          WHERE l.id=$1`,
        [event.leadId],
      )
    : null;
  const opportunity = event.opportunityId
    ? await queryOne(
        `SELECT o.id, o.title, o.status, o.value, o.sale_value, o.won_at, o.lost_at, s.name AS stage, p.name AS pipeline, c.name AS course
           FROM opportunities o JOIN pipeline_stages s ON s.id=o.stage_id JOIN pipelines p ON p.id=o.pipeline_id LEFT JOIN courses c ON c.id=o.course_id
          WHERE o.id=$1`,
        [event.opportunityId],
      )
    : null;
  return { event: event.type, occurred_at: event.at ?? new Date().toISOString(), lead, opportunity, data: event.data ?? null };
}

/** Enfileira entregas para os webhooks de saída inscritos no evento */
export async function dispatchOutbound(event: any) {
  const hooks = (await pool.query(`SELECT id, config FROM integrations WHERE type='outbound_webhook' AND active`)).rows.filter((h) =>
    (h.config?.events ?? []).includes(event.type),
  );
  if (!hooks.length) return;
  const payload = await buildEventPayload(event);
  for (const h of hooks) {
    const d = await queryOne(`INSERT INTO outbound_deliveries (integration_id, event, payload) VALUES ($1,$2,$3) RETURNING id`, [h.id, event.type, JSON.stringify(payload)]);
    await enqueue('outbound.deliver', { deliveryId: d!.id }, { maxAttempts: 8 });
  }
}

export async function deliverOutbound(p: { deliveryId: number }, job: { attempts: number }) {
  const d = await queryOne(
    `SELECT d.*, i.config, i.secrets_enc, i.active FROM outbound_deliveries d JOIN integrations i ON i.id=d.integration_id WHERE d.id=$1`,
    [p.deliveryId],
  );
  if (!d || d.status === 'delivered' || !d.active) return;
  const secret = decryptJson<{ secret?: string }>(d.secrets_enc).secret ?? '';
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  let code = 0;
  let error: string | null = null;
  try {
    const res = await fetch(d.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CRM-MicroFacil-Webhook/1.0',
        'X-CRM-Event': d.event,
        'X-CRM-Delivery': String(d.id),
        'X-CRM-Timestamp': ts,
        'X-CRM-Signature': `sha256=${hmacSha256Hex(secret, `${ts}.${body}`)}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }
  const delivered = !error;
  await pool.query(
    `UPDATE outbound_deliveries SET status=$2, response_code=$3, attempts=attempts+1, last_error=$4, delivered_at=CASE WHEN $2='delivered' THEN now() END WHERE id=$1`,
    [d.id, delivered ? 'delivered' : job.attempts >= 8 ? 'failed' : 'pending', code || null, error],
  );
  if (!delivered) {
    await logIntegration(`integration:${d.integration_id}`, 'warn', 'deliver', `Entrega #${d.id} (${d.event}) falhou: ${error}`);
    throw new Error(error!);
  }
  await pool.query(`UPDATE integrations SET last_success_at=now(), status='connected' WHERE id=$1`, [d.integration_id]);
}
