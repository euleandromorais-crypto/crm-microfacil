import { pool, queryOne } from '../../db/pool.js';
import { encrypt } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { logIntegration } from '../integrationLog.js';
import { getMetaApp, getWaAccount } from '../meta/app.js';
import { graph, GraphError } from '../meta/graph.js';

export interface ConnectInput {
  name: string;
  phone_number_id: string;
  waba_id: string;
  access_token: string;
  coexistence?: boolean;
}

/** Verifica credenciais consultando o número na Graph API */
export async function fetchPhoneInfo(phoneNumberId: string, token: string) {
  return graph<{ id: string; display_phone_number: string; verified_name: string; quality_rating?: string; platform_type?: string; code_verification_status?: string }>(
    phoneNumberId,
    { token, query: { fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status' } },
  );
}

/** Inscreve o App da Meta para receber webhooks da conta WhatsApp Business (WABA) */
export async function subscribeApp(wabaId: string, token: string) {
  return graph(`${wabaId}/subscribed_apps`, { method: 'POST', token });
}

export async function connectAccount(input: ConnectInput) {
  let info;
  try {
    info = await fetchPhoneInfo(input.phone_number_id, input.access_token);
  } catch (err) {
    throw badRequest(`Não foi possível validar as credenciais na Meta: ${(err as Error).message}`);
  }
  let subscribeError: string | null = null;
  try {
    await subscribeApp(input.waba_id, input.access_token);
  } catch (err) {
    subscribeError = (err as Error).message;
  }
  const row = await queryOne(
    `INSERT INTO wa_accounts (name, phone_number_id, waba_id, display_phone, verified_name, access_token_enc, coexistence, status, quality_rating, last_check_at, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
     ON CONFLICT (phone_number_id) DO UPDATE SET name=EXCLUDED.name, waba_id=EXCLUDED.waba_id, display_phone=EXCLUDED.display_phone,
       verified_name=EXCLUDED.verified_name, access_token_enc=EXCLUDED.access_token_enc, coexistence=EXCLUDED.coexistence,
       status=EXCLUDED.status, quality_rating=EXCLUDED.quality_rating, last_check_at=now(), last_error=EXCLUDED.last_error, updated_at=now()
     RETURNING id`,
    [input.name, input.phone_number_id, input.waba_id, info.display_phone_number, info.verified_name, encrypt(input.access_token), !!input.coexistence,
      subscribeError ? 'error' : 'connected', info.quality_rating ?? null, subscribeError ? `Falha ao inscrever webhooks: ${subscribeError}` : null],
  );
  await logIntegration(`whatsapp:${row!.id}`, subscribeError ? 'warn' : 'info', 'connect', subscribeError ? `Conta conectada, mas a inscrição de webhooks falhou: ${subscribeError}` : `Conta ${info.display_phone_number} conectada`);
  return row!.id as number;
}

export async function testAccount(id: number) {
  const acc = await getWaAccount(id);
  try {
    const info = await fetchPhoneInfo(acc.phone_number_id, acc.access_token);
    const subs = await graph<{ data: any[] }>(`${acc.waba_id}/subscribed_apps`, { token: acc.access_token }).catch((e) => ({ data: [], error: (e as Error).message }) as any);
    await pool.query(
      `UPDATE wa_accounts SET status='connected', display_phone=$2, verified_name=$3, quality_rating=$4, last_check_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`,
      [id, info.display_phone_number, info.verified_name, info.quality_rating ?? null],
    );
    await logIntegration(`whatsapp:${id}`, 'info', 'test', `Conexão OK — ${info.display_phone_number} (${info.verified_name})`);
    return { ok: true, info, webhookSubscribed: (subs.data ?? []).length > 0, subscriptionError: (subs as any).error ?? null };
  } catch (err) {
    const msg = (err as Error).message;
    await pool.query(`UPDATE wa_accounts SET status='error', last_check_at=now(), last_error=$2, updated_at=now() WHERE id=$1`, [id, msg]);
    await logIntegration(`whatsapp:${id}`, 'error', 'test', `Falha no teste de conexão: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function resubscribe(id: number) {
  const acc = await getWaAccount(id);
  await subscribeApp(acc.waba_id, acc.access_token);
  await pool.query(`UPDATE wa_accounts SET status='connected', last_error=NULL, updated_at=now() WHERE id=$1`, [id]);
  await logIntegration(`whatsapp:${id}`, 'info', 'subscribe', 'Webhooks reinscritos na conta WhatsApp Business');
}

/** Sincroniza os modelos de mensagem (templates) da WABA */
export async function syncTemplates(id: number) {
  const acc = await getWaAccount(id);
  let url: string | null = `${acc.waba_id}/message_templates`;
  let count = 0;
  const seen: string[] = [];
  let first = true;
  while (url) {
    const page: any = await graph(url, first ? { token: acc.access_token, query: { fields: 'id,name,language,status,category,components', limit: 100 } } : { token: acc.access_token });
    first = false;
    for (const t of page.data ?? []) {
      await pool.query(
        `INSERT INTO wa_templates (wa_account_id, external_id, name, language, category, status, components, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (wa_account_id, name, language) DO UPDATE SET external_id=EXCLUDED.external_id, category=EXCLUDED.category,
           status=EXCLUDED.status, components=EXCLUDED.components, synced_at=now()`,
        [id, t.id, t.name, t.language, t.category, t.status, JSON.stringify(t.components ?? [])],
      );
      seen.push(`${t.name}|${t.language}`);
      count++;
    }
    url = page.paging?.next ?? null;
  }
  await pool.query(`DELETE FROM wa_templates WHERE wa_account_id=$1 AND NOT ((name || '|' || language) = ANY($2::text[]))`, [id, seen]);
  await logIntegration(`whatsapp:${id}`, 'info', 'templates', `${count} modelo(s) sincronizado(s)`);
  return count;
}

/**
 * Coexistência: solicita à Meta o envio dos contatos (smb_app_state_sync) ou do histórico (history) do app WhatsApp Business.
 * Disponível apenas para números integrados via Embedded Signup em modo coexistência, nas primeiras 24h após o onboarding.
 */
export async function requestCoexistenceSync(id: number, syncType: 'smb_app_state_sync' | 'history') {
  const acc = await getWaAccount(id);
  if (!acc.coexistence) throw badRequest('Esta conta não está marcada como coexistência (app WhatsApp Business + API).');
  try {
    const r = await graph(`${acc.phone_number_id}/smb_app_data`, { method: 'POST', token: acc.access_token, json: { messaging_product: 'whatsapp', sync_type: syncType } });
    await logIntegration(`whatsapp:${id}`, 'info', 'coexistence_sync', `Sincronização ${syncType} solicitada`, r);
    return r;
  } catch (err) {
    await logIntegration(`whatsapp:${id}`, 'error', 'coexistence_sync', `Falha ao solicitar ${syncType}: ${(err as Error).message}`);
    throw badRequest(`A Meta recusou a solicitação: ${(err as Error).message}`);
  }
}

/**
 * Embedded Signup (inclui onboarding de coexistência): troca o "code" retornado pelo FB.login
 * por um token de negócio, inscreve o app na WABA e, quando não é coexistência, registra o número.
 */
export async function completeEmbeddedSignup(input: { code: string; waba_id: string; phone_number_id: string; coexistence: boolean; pin?: string | null; name?: string | null }) {
  const app = await getMetaApp();
  if (!app?.app_id || !app.app_secret) throw badRequest('Configure o App da Meta (App ID e App Secret) antes de usar o cadastro incorporado.');
  let token: string;
  try {
    const r = await graph<{ access_token: string }>('oauth/access_token', { query: { client_id: app.app_id, client_secret: app.app_secret, code: input.code } });
    token = r.access_token;
  } catch (err) {
    throw badRequest(`Falha ao trocar o código de autorização: ${(err as Error).message}`);
  }
  if (!input.coexistence) {
    if (!input.pin || !/^\d{6}$/.test(input.pin)) throw badRequest('Informe um PIN de 6 dígitos para registrar o número na Cloud API');
    try {
      await graph(`${input.phone_number_id}/register`, { method: 'POST', token, json: { messaging_product: 'whatsapp', pin: input.pin } });
    } catch (err) {
      if (!(err instanceof GraphError) || !/already registered/i.test(err.message)) throw badRequest(`Falha ao registrar o número: ${(err as Error).message}`);
    }
  }
  return connectAccount({ name: input.name || 'WhatsApp', phone_number_id: input.phone_number_id, waba_id: input.waba_id, access_token: token, coexistence: input.coexistence });
}
