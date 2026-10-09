import { pool, queryOne } from '../../db/pool.js';
import { decrypt, decryptJson } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';

export interface MetaAppConfig {
  integrationId: number;
  app_id?: string;
  app_secret?: string;
  verify_token?: string;
  embedded_signup_config_id?: string;
}

/** Configuração do App da Meta (um único registro do tipo meta_app) */
export async function getMetaApp(): Promise<MetaAppConfig | null> {
  const row = await queryOne(`SELECT id, config, secrets_enc FROM integrations WHERE type='meta_app' ORDER BY id LIMIT 1`);
  if (!row) return null;
  const secrets = decryptJson<{ app_secret?: string; verify_token?: string }>(row.secrets_enc);
  return { integrationId: row.id, ...row.config, ...secrets };
}

export async function getWaAccount(id: number) {
  const row = await queryOne('SELECT * FROM wa_accounts WHERE id=$1', [id]);
  if (!row) throw notFound('Conta de WhatsApp não encontrada');
  return { ...row, access_token: decrypt(row.access_token_enc) as string };
}

export async function getWaAccountByPhoneNumberId(phoneNumberId: string) {
  const row = await queryOne('SELECT * FROM wa_accounts WHERE phone_number_id=$1', [phoneNumberId]);
  if (!row) return null;
  return { ...row, access_token: decrypt(row.access_token_enc) as string };
}

export async function defaultWaAccount() {
  const row = await queryOne(`SELECT id FROM wa_accounts WHERE status <> 'disabled' ORDER BY (status='connected') DESC, id LIMIT 1`, [], pool);
  return row ? getWaAccount(row.id) : null;
}
