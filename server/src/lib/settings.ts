import { pool, Queryable } from '../db/pool.js';
import { invalidateSettingsCache } from './auth.js';

export const SETTINGS_DEFAULTS = {
  general: {
    company_name: 'Micro Fácil',
    /** minutos para o primeiro contato antes de gerar alerta de SLA */
    sla_first_contact_minutes: 60,
    /** dias sem interação para considerar um lead parado */
    stale_lead_days: 3,
    /** dias sem interação para sinalizar reativação */
    reactivation_days: 60,
    /** dias padrão para considerar uma oportunidade parada na etapa (quando a etapa não define) */
    opportunity_stale_days: 7,
    /** vendedores enxergam leads sem responsável */
    sellers_see_unassigned: false,
    /** origens de lead sugeridas no cadastro */
    sources: ['Site', 'Landing page', 'Meta Lead Ads', 'Instagram', 'WhatsApp', 'Indicação', 'Google', 'Telefone', 'Presencial', 'Importação'],
  },
  distribution: {
    /** manual | round_robin | least_loaded */
    mode: 'round_robin' as 'manual' | 'round_robin' | 'least_loaded',
    /** cria oportunidade automaticamente quando um lead entra por integração */
    auto_create_opportunity: true,
    /** cria tarefa de primeiro contato para o responsável */
    auto_first_contact_task: true,
    first_contact_task_minutes: 15,
    last_user_id: null as number | null,
  },
  whatsapp: {
    /** cria lead automaticamente quando chega mensagem de número desconhecido */
    auto_create_lead: true,
    default_source: 'WhatsApp',
    /** atribui conversa ao responsável do lead */
    assign_to_lead_owner: true,
    /** distribui conversas de leads sem responsável */
    distribute_unassigned: true,
    /** reabre conversa encerrada quando o cliente envia nova mensagem */
    reopen_on_inbound: true,
  },
};

export type Settings = typeof SETTINGS_DEFAULTS;
export type SettingsKey = keyof Settings;

export async function getSetting<K extends SettingsKey>(key: K, db: Queryable = pool): Promise<Settings[K]> {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return { ...SETTINGS_DEFAULTS[key], ...(r.rows[0]?.value ?? {}) } as Settings[K];
}

export async function setSetting<K extends SettingsKey>(key: K, value: Partial<Settings[K]>, userId: number | null, db: Queryable = pool) {
  const current = await getSetting(key, db);
  const merged = { ...current, ...value };
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(merged), userId],
  );
  invalidateSettingsCache();
  return merged;
}
