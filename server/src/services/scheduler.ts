import { pool } from '../db/pool.js';
import { enqueue, pruneJobs, registerJob } from '../lib/jobs.js';
import { notifyUser } from '../lib/notify.js';
import { localDate } from '../lib/time.js';
import { handleAutomationRun, handleDomainEvent, runScheduledRules } from './automations.js';
import { processInboundWebhookJob } from './inboundWebhook.js';
import { syncAdsInsights } from './meta/adsInsights.js';
import { fetchAndIntakeLeadgen } from './meta/leadAds.js';
import { processMetaWebhookJob } from './meta/webhook.js';
import { deliverOutbound } from './outboundWebhooks.js';
import { downloadMediaJob } from './whatsapp/media.js';
import { retrySendJob } from './whatsapp/outbound.js';

/** Registra todos os tipos de job conhecidos */
export function registerAllJobs() {
  registerJob('domain.event', handleDomainEvent);
  registerJob('automation.run', handleAutomationRun);
  registerJob('meta.webhook', processMetaWebhookJob);
  registerJob('meta.leadgen', fetchAndIntakeLeadgen);
  registerJob('inbound.webhook', processInboundWebhookJob);
  registerJob('outbound.deliver', deliverOutbound);
  registerJob('wa.media.download', downloadMediaJob);
  registerJob('wa.send.retry', retrySendJob);
  registerJob('ads.insights', (p: { integrationId: number; days?: number }) => syncAdsInsights(p.integrationId, p.days ?? 7).then(() => undefined));
}

/** Lembretes de atividades e alertas de vencimento */
export async function processTaskReminders() {
  const due = (
    await pool.query(
      `UPDATE tasks SET reminded_at=now()
        WHERE status='pending' AND reminded_at IS NULL AND assignee_id IS NOT NULL
          AND due_at - make_interval(mins => remind_minutes_before) <= now() AND due_at > now() - interval '1 hour'
        RETURNING id, title, assignee_id, due_at`,
    )
  ).rows;
  for (const t of due) {
    const when = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(t.due_at));
    await notifyUser({ userId: t.assignee_id, type: 'task.reminder', title: `Lembrete: ${t.title}`, body: `Agendado para ${when}`, link: `/agenda?task=${t.id}` });
  }
  const overdue = (
    await pool.query(
      `UPDATE tasks SET overdue_notified_at=now()
        WHERE status='pending' AND overdue_notified_at IS NULL AND assignee_id IS NOT NULL AND due_at < now() - interval '5 minutes'
        RETURNING id, title, assignee_id`,
    )
  ).rows;
  for (const t of overdue) {
    await notifyUser({ userId: t.assignee_id, type: 'task.overdue', title: 'Atividade vencida', body: t.title, link: `/agenda?task=${t.id}` });
  }
  return due.length + overdue.length;
}

async function housekeeping() {
  await pruneJobs();
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await pool.query(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '3 days'`);
  await pool.query(`DELETE FROM webhook_events WHERE status IN ('processed','ignored') AND received_at < now() - interval '90 days'`);
  await pool.query(`DELETE FROM integration_logs WHERE created_at < now() - interval '180 days'`);
  await pool.query(`DELETE FROM automation_runs WHERE status='skipped' AND created_at < now() - interval '90 days'`);
  await pool.query(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days'`);
  // eventos de webhook presos (processo caiu antes de enfileirar/processar): reenfileira
  const stuck = (await pool.query(`SELECT id, provider FROM webhook_events WHERE status='received' AND received_at < now() - interval '15 minutes' AND attempts < 10 LIMIT 100`)).rows;
  for (const e of stuck) {
    if (e.provider === 'meta') await enqueue('meta.webhook', { eventId: e.id }, { dedupeKey: `wh-${e.id}` });
    else if (e.provider.startsWith('inbound:')) await enqueue('inbound.webhook', { eventId: e.id, integrationId: Number(e.provider.split(':')[1]) }, { dedupeKey: `wh-${e.id}` });
  }
}

async function dailyAdsSync() {
  const today = localDate();
  const integrations = (await pool.query(`SELECT id FROM integrations WHERE type='meta_ads_insights' AND active`)).rows;
  for (const i of integrations) {
    const key = `ads-insights-${i.id}-${today}`;
    const exists = await pool.query('SELECT 1 FROM jobs WHERE dedupe_key=$1', [key]);
    if (!exists.rowCount) await enqueue('ads.insights', { integrationId: i.id, days: 7 }, { dedupeKey: key, maxAttempts: 4 });
  }
}

let last = { rules: 0, housekeeping: 0, ads: 0 };

/** Um ciclo do agendador. Protegido por trava consultiva: só um processo executa por vez. */
export async function schedulerTick(log?: { error: (...a: any[]) => void }) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(7700001) AS ok');
    if (!rows[0].ok) return;
    try {
      const now = Date.now();
      await processTaskReminders().catch((err) => log?.error({ err }, 'lembretes de tarefas'));
      if (now - last.rules > 5 * 60_000) {
        last.rules = now;
        await runScheduledRules().catch((err) => log?.error({ err }, 'automações agendadas'));
      }
      if (now - last.housekeeping > 60 * 60_000) {
        last.housekeeping = now;
        await housekeeping().catch((err) => log?.error({ err }, 'manutenção'));
      }
      if (now - last.ads > 60 * 60_000) {
        last.ads = now;
        await dailyAdsSync().catch((err) => log?.error({ err }, 'sync insights'));
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(7700001)');
    }
  } finally {
    client.release();
  }
}

export function resetSchedulerState() {
  last = { rules: 0, housekeeping: 0, ads: 0 };
}
