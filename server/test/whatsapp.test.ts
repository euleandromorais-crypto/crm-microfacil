import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createUser, drainJobs, FakeGraph, getApp, login, postMetaWebhook, resetData, waMessagePayload, waStatusPayload } from './helpers.js';

const APP_SECRET = 'segredo-do-app-de-teste-123';
const PHONE_ID = '1098765432';

describe('WhatsApp Cloud API', () => {
  const graph = new FakeGraph();
  let admin: Awaited<ReturnType<typeof login>>;
  let seller: Awaited<ReturnType<typeof login>>;
  let sellerId: number;
  let convId: number;

  beforeAll(async () => {
    await graph.start();
    await getApp();
    await resetData();
    const a = await createUser('Admin', 'admin');
    const s = await createUser('Vendedora Wa', 'seller');
    sellerId = s.id;
    admin = await login(a.email);
    seller = await login(s.email);
  });
  afterAll(() => graph.stop());

  it('configura o App da Meta e conecta o número validando na Graph API', async () => {
    const r = await admin.put('/api/integrations/meta-app', { app_id: '123456', app_secret: APP_SECRET, verify_token: 'token-verificacao-xyz' });
    expect(r.status).toBe(200);
    const acc = await admin.post('/api/wa/accounts', { name: 'Comercial', phone_number_id: PHONE_ID, waba_id: '555000', access_token: 'EAAG-token-de-teste-bem-longo', coexistence: true });
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe('connected');
    expect(graph.calls.some((c) => c.path === '555000/subscribed_apps' && c.method === 'POST')).toBe(true);
    // token armazenado criptografado
    const row = (await pool.query('SELECT access_token_enc FROM wa_accounts')).rows[0];
    expect(row.access_token_enc).not.toContain('EAAG');
  });

  it('verificação do webhook (hub.challenge)', async () => {
    const a = await getApp();
    const ok = await a.inject({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=token-verificacao-xyz&hub.challenge=4242' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('4242');
    const bad = await a.inject({ method: 'GET', url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejeita webhook com assinatura inválida', async () => {
    const res = await postMetaWebhook(waMessagePayload(PHONE_ID, []), APP_SECRET, 'sha256=deadbeef');
    expect(res.statusCode).toBe(401);
  });

  it('recebe mensagem: cria lead, conversa, distribui e registra no histórico', async () => {
    const payload = waMessagePayload(
      PHONE_ID,
      [{ from: '5511912345678', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Olá, quero saber do curso de Excel' } }],
      [{ profile: { name: 'João Cliente' }, wa_id: '5511912345678' }],
    );
    const res = await postMetaWebhook(payload, APP_SECRET);
    expect(res.statusCode).toBe(200);
    // reenvio idêntico da Meta é deduplicado
    const again = await postMetaWebhook(payload, APP_SECRET);
    expect(again.statusCode).toBe(200);
    await drainJobs();
    const msgs = (await pool.query(`SELECT * FROM messages WHERE wamid='wamid.IN1'`)).rows;
    expect(msgs).toHaveLength(1);
    const conv = (await pool.query('SELECT * FROM conversations WHERE id=$1', [msgs[0].conversation_id])).rows[0];
    convId = conv.id;
    expect(conv.unread_count).toBe(1);
    expect(conv.awaiting_reply).toBe(true);
    expect(conv.assignee_id).toBe(sellerId);
    const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [conv.lead_id])).rows[0];
    expect(lead.name).toBe('João Cliente');
    expect(lead.phone).toBe('5511912345678');
    expect(lead.source).toBe('WhatsApp');
    expect(lead.owner_id).toBe(sellerId);
    const ev = (await pool.query(`SELECT * FROM lead_events WHERE lead_id=$1 AND type='whatsapp_in'`, [lead.id])).rows;
    expect(ev).toHaveLength(1);
  });

  it('mesma mensagem em outro corpo de webhook não duplica (wamid único)', async () => {
    const payload = waMessagePayload(PHONE_ID, [{ from: '5511912345678', id: 'wamid.IN1', timestamp: '1', type: 'text', text: { body: 'Olá, quero saber do curso de Excel' } }]);
    await postMetaWebhook(payload, APP_SECRET);
    await drainJobs();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM messages WHERE wamid='wamid.IN1'`)).rows[0].n;
    expect(n).toBe(1);
  });

  it('vendedor vê a conversa, envia resposta dentro da janela e o histórico é atualizado', async () => {
    const list = await seller.get('/api/conversations?filter=mine');
    expect(list.body.rows.map((c: any) => c.id)).toContain(convId);
    const sent = await seller.post(`/api/conversations/${convId}/messages`, { text: 'Oi João! Tenho sim, posso te enviar os detalhes?' });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.wamid).toMatch(/^wamid\.OUT/);
    const call = graph.calls.filter((c) => c.path === `${PHONE_ID}/messages`).pop()!;
    expect(call.body).toMatchObject({ messaging_product: 'whatsapp', to: '5511912345678', type: 'text' });
    expect(call.auth).toBe('Bearer EAAG-token-de-teste-bem-longo');
    const conv = (await pool.query('SELECT * FROM conversations WHERE id=$1', [convId])).rows[0];
    expect(conv.awaiting_reply).toBe(false);
    expect(conv.first_response_at).not.toBeNull();
    const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [conv.lead_id])).rows[0];
    expect(lead.first_contact_at).not.toBeNull();
  });

  it('status de entrega/leitura: aplica em ordem e ignora regressões', async () => {
    const out = (await pool.query(`SELECT wamid FROM messages WHERE conversation_id=$1 AND direction='out' ORDER BY id DESC LIMIT 1`, [convId])).rows[0];
    const ts = String(Math.floor(Date.now() / 1000));
    await postMetaWebhook(waStatusPayload(PHONE_ID, [{ id: out.wamid, status: 'read', timestamp: ts, recipient_id: '5511912345678' }]), APP_SECRET);
    await postMetaWebhook(waStatusPayload(PHONE_ID, [{ id: out.wamid, status: 'delivered', timestamp: ts, recipient_id: '5511912345678' }]), APP_SECRET);
    await drainJobs();
    const m = (await pool.query(`SELECT status FROM messages WHERE wamid=$1`, [out.wamid])).rows[0];
    expect(m.status).toBe('read');
  });

  it('nota interna não é enviada ao cliente', async () => {
    const before = graph.calls.length;
    const n = await seller.post(`/api/conversations/${convId}/notes`, { text: 'Cliente prefere contato à noite' });
    expect(n.status).toBe(200);
    expect(graph.calls.length).toBe(before);
  });

  it('fora da janela de 24h só permite modelo aprovado', async () => {
    await pool.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id=$1`, [convId]);
    const blocked = await seller.post(`/api/conversations/${convId}/messages`, { text: 'Oi de novo' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.details.code).toBe('window_closed');
    const sync = await admin.post(`/api/wa/accounts/1/templates/sync`);
    expect(sync.body.count).toBe(1);
    const t = await seller.post(`/api/conversations/${convId}/template`, { name: 'retomar_contato', language: 'pt_BR', body_params: ['João'] });
    expect(t.status).toBe(200);
    expect(t.body.body).toBe('Olá João, ainda tem interesse no curso?');
    const call = graph.calls.filter((c) => c.path === `${PHONE_ID}/messages`).pop()!;
    expect(call.body.type).toBe('template');
    expect(call.body.template.components[0].parameters[0].text).toBe('João');
  });

  it('falha permanente da Meta marca a mensagem como falha (com motivo)', async () => {
    await pool.query(`UPDATE conversations SET last_inbound_at = now() WHERE id=$1`, [convId]);
    graph.handlers.set(`POST ${PHONE_ID}/messages`, () => ({ status: 400, json: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } } }));
    const r = await seller.post(`/api/conversations/${convId}/messages`, { text: 'teste falha' });
    expect(r.status).toBe(400);
    const m = (await pool.query(`SELECT * FROM messages WHERE body='teste falha'`)).rows[0];
    expect(m.status).toBe('failed');
    expect(m.error.code).toBe(131030);
    graph.handlers.clear();
    // reenvio manual
    const re = await seller.post(`/api/messages/${m.id}/resend`);
    expect(re.status).toBe(200);
    expect(re.body.status).toBe('sent');
  });

  it('falha temporária (5xx) é re-tentada em segundo plano', async () => {
    let n = 0;
    graph.handlers.set(`POST ${PHONE_ID}/messages`, (c) => (++n === 1 ? { status: 503, json: { error: { message: 'Service unavailable', code: 2 } } } : { json: { messages: [{ id: 'wamid.RETRY1' }] } }));
    const r = await seller.post(`/api/conversations/${convId}/messages`, { text: 'mensagem com retry' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('queued');
    await pool.query(`UPDATE jobs SET run_at=now() WHERE type='wa.send.retry'`);
    await drainJobs();
    const m = (await pool.query(`SELECT * FROM messages WHERE body='mensagem com retry'`)).rows[0];
    expect(m.status).toBe('sent');
    expect(m.wamid).toBe('wamid.RETRY1');
    graph.handlers.clear();
  });

  it('coexistência: mensagens enviadas pelo app do celular entram no histórico', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID },
        message_echoes: [{ from: '551140000000', to: '5511912345678', id: 'wamid.ECHO1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Enviei pelo celular' } }] } }] }],
    };
    await postMetaWebhook(payload, APP_SECRET);
    await drainJobs();
    const m = (await pool.query(`SELECT * FROM messages WHERE wamid='wamid.ECHO1'`)).rows[0];
    expect(m.direction).toBe('out');
    expect(m.origin).toBe('phone_app');
    expect(m.conversation_id).toBe(convId);
  });

  it('mídia recebida é baixada e armazenada localmente', async () => {
    graph.handlers.set('GET media-abc', () => ({ json: { url: `http://127.0.0.1:47011/v23.0/download/media-abc`, mime_type: 'image/jpeg', file_size: 4 } }));
    graph.handlers.set('GET download/media-abc', () => ({ json: 'IMG' }));
    await postMetaWebhook(waMessagePayload(PHONE_ID, [{ from: '5511912345678', id: 'wamid.IMG1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-abc', mime_type: 'image/jpeg', caption: 'foto do boleto' } }]), APP_SECRET);
    await drainJobs();
    const m = (await pool.query(`SELECT * FROM messages WHERE wamid='wamid.IMG1'`)).rows[0];
    expect(m.media_status).toBe('ready');
    const file = await seller.get(`/api/messages/${m.id}/media`);
    expect(file.status).toBe(200);
  });

  it('encerra e reabre o atendimento; nova mensagem do cliente reabre automaticamente', async () => {
    expect((await seller.post(`/api/conversations/${convId}/close`, { reason: 'Matriculado' })).status).toBe(200);
    let c = (await pool.query('SELECT status FROM conversations WHERE id=$1', [convId])).rows[0];
    expect(c.status).toBe('closed');
    await postMetaWebhook(waMessagePayload(PHONE_ID, [{ from: '5511912345678', id: 'wamid.IN2', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Mais uma dúvida' } }]), APP_SECRET);
    await drainJobs();
    c = (await pool.query('SELECT status FROM conversations WHERE id=$1', [convId])).rows[0];
    expect(c.status).toBe('open');
    const sessions = (await pool.query('SELECT count(*)::int AS n FROM conversation_sessions WHERE conversation_id=$1', [convId])).rows[0].n;
    expect(sessions).toBe(2);
  });

  it('transferência de atendimento entre vendedores', async () => {
    const other = await createUser('Outro Vendedor', 'seller');
    const r = await seller.post(`/api/conversations/${convId}/assign`, { assignee_id: other.id, transfer_lead: true, note: 'Férias' });
    expect(r.status).toBe(200);
    const c = (await pool.query('SELECT assignee_id, lead_id FROM conversations WHERE id=$1', [convId])).rows[0];
    expect(c.assignee_id).toBe(other.id);
    const l = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [c.lead_id])).rows[0];
    expect(l.owner_id).toBe(other.id);
    // a vendedora original perde acesso
    expect((await seller.get(`/api/conversations/${convId}`)).status).toBe(403);
  });
});
