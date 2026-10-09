import { pool, queryOne } from '../../db/pool.js';
import { decryptJson } from '../../lib/crypto.js';
import { addDays, localDate } from '../../lib/time.js';
import { logIntegration } from '../integrationLog.js';
import { graph } from './graph.js';

/**
 * Importa investimento diário por campanha (Meta Ads Insights) para cálculo de CPL, CPA e ROAS.
 * Requer token com permissão ads_read para a conta de anúncios.
 */
export async function syncAdsInsights(integrationId: number, days = 30) {
  const row = await queryOne(`SELECT * FROM integrations WHERE id=$1 AND type='meta_ads_insights'`, [integrationId]);
  if (!row) throw new Error('Integração não encontrada');
  const secrets = decryptJson<{ access_token?: string }>(row.secrets_enc);
  const account = String(row.config?.ad_account_id ?? '').replace(/^act_/, '');
  if (!secrets.access_token || !account) throw new Error('Informe o ID da conta de anúncios e o token de acesso');
  const until = localDate();
  const since = addDays(until, -days);
  let url: string | null = `act_${account}/insights`;
  let first = true;
  let rows = 0;
  try {
    while (url) {
      const page: any = await graph(url, first
        ? { token: secrets.access_token, query: { level: 'campaign', fields: 'campaign_id,campaign_name,spend,impressions,clicks,date_start', time_increment: 1, time_range: JSON.stringify({ since, until }), limit: 500 } }
        : { token: secrets.access_token });
      first = false;
      for (const r of page.data ?? []) {
        const camp = await queryOne(
          `INSERT INTO campaigns (name, channel, external_id) VALUES ($1,'meta_ads',$2)
           ON CONFLICT (channel, external_id) WHERE external_id IS NOT NULL DO UPDATE SET updated_at=now()
           RETURNING id`,
          [r.campaign_name, r.campaign_id],
        );
        await pool.query(
          `INSERT INTO campaign_spend (campaign_id, day, amount, impressions, clicks, source) VALUES ($1,$2,$3,$4,$5,'meta_ads')
           ON CONFLICT (campaign_id, day, source) DO UPDATE SET amount=EXCLUDED.amount, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, updated_at=now()`,
          [camp!.id, r.date_start, Number(r.spend ?? 0), Number(r.impressions ?? 0), Number(r.clicks ?? 0)],
        );
        rows++;
      }
      url = page.paging?.next ?? null;
    }
    await pool.query(`UPDATE integrations SET status='connected', last_success_at=now(), last_error=NULL WHERE id=$1`, [integrationId]);
    await logIntegration(`integration:${integrationId}`, 'info', 'sync', `Insights sincronizados: ${rows} registro(s) diário(s) de ${since} a ${until}`);
    return rows;
  } catch (err) {
    const msg = (err as Error).message;
    await pool.query(`UPDATE integrations SET status='error', last_error_at=now(), last_error=$2 WHERE id=$1`, [integrationId, msg]);
    await logIntegration(`integration:${integrationId}`, 'error', 'sync', `Falha ao sincronizar insights: ${msg}`);
    throw err;
  }
}
