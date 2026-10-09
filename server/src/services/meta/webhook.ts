import { pool, queryOne } from '../../db/pool.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import { enqueue, PermanentError } from '../../lib/jobs.js';
import { logIntegration } from '../integrationLog.js';
import { processWhatsAppChange } from '../whatsapp/inbound.js';

export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${hmacSha256Hex(appSecret, rawBody)}`;
  return safeEqual(expected, header);
}

/** Job: processa um evento de webhook da Meta já persistido */
export async function processMetaWebhookJob(p: { eventId: number }, job: { attempts: number }) {
  const ev = await queryOne('SELECT * FROM webhook_events WHERE id=$1', [p.eventId]);
  if (!ev || ev.status === 'processed') return;
  await pool.query(`UPDATE webhook_events SET status='processing', attempts=attempts+1 WHERE id=$1`, [ev.id]);
  const payload = ev.payload;
  try {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (payload.object === 'whatsapp_business_account') {
          await processWhatsAppChange(change, job.attempts);
        } else if (payload.object === 'page' && change.field === 'leadgen') {
          const v = change.value ?? {};
          await enqueue('meta.leadgen', { leadgen_id: String(v.leadgen_id), page_id: String(v.page_id ?? entry.id), form_id: v.form_id ? String(v.form_id) : undefined, created_time: v.created_time }, { dedupeKey: `leadgen-${v.leadgen_id}` });
        } else {
          await logIntegration('meta', 'info', 'webhook', `Evento ${payload.object}/${change.field} ignorado`);
        }
      }
    }
    await pool.query(`UPDATE webhook_events SET status='processed', processed_at=now(), error=NULL WHERE id=$1`, [ev.id]);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    await pool.query(`UPDATE webhook_events SET status=$2, error=$3 WHERE id=$1`, [ev.id, permanent ? 'failed' : 'received', (err as Error).message]);
    throw err;
  }
}
