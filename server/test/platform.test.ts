import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { hmacSha256Hex } from '../src/lib/crypto.js';
import { runScheduledRules } from '../src/services/automations.js';
import { createUser, drainJobs, FakeGraph, getApp, login, postMetaWebhook, resetData } from './helpers.js';

describe('autenticação e segurança', () => {
  beforeAll(async () => {
    await getApp();
    await resetData();
    await createUser('Admin Seg', 'admin');
  });

  it('bloqueia requisições de alteração sem cabeçalho anti-CSRF', async () => {
    const a = await getApp();
    const l = await login('admin.seg@teste.com');
    const r = await a.inject({ method: 'POST', url: '/api/leads', headers: { cookie: l.cookie.split(';')[0] }, payload: { name: 'X', phone: '11999990000' } });
    expect(r.statusCode).toBe(403);
  });

  it('exige autenticação nas rotas da API', async () => {
    const a = await getApp();
    expect((await a.inject({ method: 'GET', url: '/api/leads' })).statusCode).toBe(401);
  });

  it('bloqueia temporariamente após 5 senhas erradas', async () => {
    const a = await getApp();
    for (let i = 0; i < 5; i++) await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin.seg@teste.com', password: 'errada' } });
    const r = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin.seg@teste.com', password: 'Senha1234' } });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).error).toContain('bloqueado');
    await pool.query(`UPDATE users SET locked_until=NULL, failed_logins=0`);
  });

  it('redefinição de senha por link de uso único', async () => {
    const admin = await login('admin.seg@teste.com');
    const u = await createUser('Esqueceu Senha', 'seller');
    const link = (await admin.post(`/api/users/${u.id}/reset-link`)).body.link as string;
    const token = new URL(link).searchParams.get('token');
    const a = await getApp();
    const r1 = await a.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'NovaSenha99' } });
    expect(r1.statusCode).toBe(200);
    const r2 = await a.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'OutraSenha99' } });
    expect(r2.statusCode).toBe(400);
    await login(u.email, 'NovaSenha99');
  });

  it('usuário desativado perde o acesso imediatamente', async () => {
    const admin = await login('admin.seg@teste.com');
    const u = await createUser('Sera Desativado', 'seller');
    const s = await login(u.email);
    expect((await s.get('/api/auth/me')).status).toBe(200);
    await admin.patch(`/api/users/${u.id}`, { active: false });
    expect((await s.get('/api/auth/me')).status).toBe(401);
  });
});

describe('leads: cadastro, duplicidade, mesclagem, importação e lote', () => {
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    await resetData();
    const a = await createUser('Gestor Leads', 'admin');
    await createUser('Vend A', 'seller');
    admin = await login(a.email);
  });

  it('impede cadastro manual duplicado e permite mesclar duplicados existentes', async () => {
    const l1 = await admin.post('/api/leads', { name: 'Pedro Alves', phone: '31988887777', create_opportunity: true });
    expect(l1.status).toBe(200);
    const dup = await admin.post('/api/leads', { name: 'Pedro A.', phone: '(31) 98888-7777' });
    expect(dup.status).toBe(400);
    expect(dup.body.details.duplicateId).toBe(l1.body.id);
    // duplicado criado por fora do fluxo (ex.: dado legado) e mesclado
    const l2 = await admin.post('/api/leads', { name: 'Pedro Alves', email: 'pedro@ex.com' });
    const groups = await admin.get('/api/leads/duplicates');
    expect(groups.body.some((g: any) => g.reason === 'name')).toBe(true);
    const merged = await admin.post('/api/leads/merge', { primary_id: l1.body.id, secondary_ids: [l2.body.id] });
    expect(merged.status).toBe(200);
    expect(merged.body.email).toBe('pedro@ex.com');
    const old = await admin.get(`/api/leads/${l2.body.id}`);
    expect(old.body.redirect).toBe(l1.body.id);
    const opps = (await pool.query('SELECT count(*)::int AS n FROM opportunities WHERE lead_id=$1', [l1.body.id])).rows[0].n;
    expect(opps).toBe(2); // oportunidades dos dois cadastros ficam no principal
  });

  it('um lead pode ter várias oportunidades sem duplicar o cadastro', async () => {
    const l = await admin.post('/api/leads', { name: 'Rita', phone: '41999998888', create_opportunity: false });
    const o1 = await admin.post('/api/opportunities', { lead_id: l.body.id });
    const o2 = await admin.post('/api/opportunities', { lead_id: l.body.id, value: 500 });
    expect(o1.status).toBe(200);
    expect(o2.status).toBe(200);
    const p = await admin.get(`/api/leads/${l.body.id}`);
    expect(p.body.opportunities).toHaveLength(2);
  });

  it('importa CSV com deduplicação e relatório de erros', async () => {
    const a = await getApp();
    const csv = 'Nome;Telefone;E-mail;Curso\nLuiza;11 97777-6666;luiza@ex.com;\nLuiza Repetida;11977776666;;\nSem Contato;;;\n';
    const boundary = '----crmtest';
    const part = (name: string, value: string, filename?: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n${filename ? 'Content-Type: text/csv\r\n' : ''}\r\n${value}\r\n`;
    const body = part('mode', 'commit') + part('mapping', JSON.stringify(['name', 'phone', 'email', 'course'])) + part('options', JSON.stringify({ distribute: false, create_opportunity: false })) + part('file', csv, 'leads.csv') + `--${boundary}--\r\n`;
    const r = await a.inject({ method: 'POST', url: '/api/leads/import', payload: body, headers: { cookie: admin.cookie.split(';')[0], 'x-requested-with': 'crm', 'content-type': `multipart/form-data; boundary=${boundary}` } });
    const res = JSON.parse(r.body);
    expect(r.statusCode).toBe(200);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].line).toBe(4);
    const luiza = (await pool.query(`SELECT owner_id FROM leads WHERE email='luiza@ex.com'`)).rows[0];
    expect(luiza.owner_id).toBeNull(); // sem distribuição
  });

  it('ações em lote: atribuir e etiquetar', async () => {
    const leads = (await admin.get('/api/leads')).body.rows;
    const ids = leads.map((l: any) => l.id);
    const tag = await admin.post('/api/tags', { name: 'Black Friday', color: '#ff0000' });
    const vend = (await pool.query(`SELECT id FROM users WHERE role='seller'`)).rows[0].id;
    expect((await admin.post('/api/leads/bulk', { ids, action: 'assign', owner_id: vend })).status).toBe(200);
    const t = await admin.post('/api/leads/bulk', { ids, action: 'add_tag', tag_id: tag.body.id });
    expect(t.body.affected).toBe(ids.length);
    const f = await admin.get(`/api/leads?tag_id=${tag.body.id}&owner_id=${vend}`);
    expect(f.body.total).toBe(ids.length);
  });

  it('campos personalizados validados e filtráveis', async () => {
    await admin.post('/api/custom-fields', { key: 'escolaridade', label: 'Escolaridade', type: 'select', options: ['Médio', 'Superior'], required: false });
    const bad = await admin.post('/api/leads', { name: 'Teste CF', phone: '51999990000', custom: { escolaridade: 'Doutorado' } });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/leads', { name: 'Teste CF', phone: '51999990000', custom: { escolaridade: 'Superior' } });
    expect(ok.status).toBe(200);
    const f = await admin.get('/api/leads?cf_escolaridade=Superior');
    expect(f.body.total).toBe(1);
  });
});

describe('automações', () => {
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    await resetData();
    const a = await createUser('Admin Auto', 'admin');
    await createUser('Vend Auto', 'seller');
    admin = await login(a.email);
  });

  it('gatilho de evento: novo lead de origem específica cria tarefa', async () => {
    const tag = await admin.post('/api/tags', { name: 'Indicação', color: '#00aa00' });
    const rule = await admin.post('/api/automations', {
      name: 'Indicação → ligar em 10 min', trigger: 'lead.created', conditions: [{ field: 'lead.source', op: 'eq', value: 'Indicação' }],
      actions: [{ type: 'create_task', task_type: 'call', title: 'Ligar para {{lead.name}}', due_in_minutes: 10, assignee: 'owner' }, { type: 'add_tag', tag_id: tag.body.id }],
    });
    expect(rule.status).toBe(200);
    const l1 = await admin.post('/api/leads', { name: 'Indicado Um', phone: '11955554444', source: 'Indicação', create_opportunity: false });
    const l2 = await admin.post('/api/leads', { name: 'Site Dois', phone: '11955553333', source: 'Site', create_opportunity: false });
    await drainJobs();
    const t1 = (await pool.query(`SELECT * FROM tasks WHERE lead_id=$1 AND type='call'`, [l1.body.id])).rows;
    expect(t1).toHaveLength(1);
    expect(t1[0].title).toBe('Ligar para Indicado Um');
    const t2 = (await pool.query(`SELECT * FROM tasks WHERE lead_id=$1 AND type='call'`, [l2.body.id])).rows;
    expect(t2).toHaveLength(0);
    const runs = await admin.get('/api/automations/runs');
    expect(runs.body[0].status).toBe('success');
  });

  it('gatilho de tempo: lead sem contato gera alerta uma única vez', async () => {
    await admin.post('/api/automations', { name: 'SLA', trigger: 'lead.no_contact', trigger_config: { minutes: 30 }, actions: [{ type: 'notify', to: 'managers', title: 'Sem contato: {{lead.name}}' }] });
    await pool.query(`UPDATE leads SET created_at = now() - interval '2 hours'`);
    await runScheduledRules();
    await runScheduledRules();
    const n = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE title LIKE 'Sem contato:%'`)).rows[0].n;
    expect(n).toBe(2); // 2 leads x 1 gestor, sem repetição
  });

  it('falha em ação é registrada sem interromper as demais', async () => {
    const rule = await admin.post('/api/automations', { name: 'Quebrada', trigger: 'lead.created', actions: [{ type: 'move_opportunity', stage_id: 1 }, { type: 'flag_reactivation' }] });
    const l = await admin.post('/api/leads', { name: 'Lead Z', phone: '11955552222', create_opportunity: false });
    await drainJobs();
    const run = (await pool.query('SELECT * FROM automation_runs WHERE rule_id=$1', [rule.body.id])).rows[0];
    expect(run.status).toBe('partial');
    const lead = (await pool.query('SELECT reactivation_flag FROM leads WHERE id=$1', [l.body.id])).rows[0];
    expect(lead.reactivation_flag).toBe(true);
  });
});

describe('integrações de captação', () => {
  const graph = new FakeGraph(47011);
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    await graph.start();
    await resetData();
    const a = await createUser('Admin Int', 'admin');
    await createUser('Vend Int', 'seller');
    admin = await login(a.email);
    await admin.put('/api/integrations/meta-app', { app_id: '999', app_secret: 'app-secret-integracoes' });
  });
  afterAll(() => graph.stop());

  it('Meta Lead Ads: webhook leadgen busca o lead na Graph API e cria no CRM com campanha', async () => {
    const course = await admin.post('/api/courses', { name: 'Administração', code: 'ADM' });
    const integ = await admin.post('/api/integrations', { type: 'meta_lead_ads', name: 'Página MF', config: { page_ids: ['777'], form_courses: { '888': course.body.id } }, secrets: { page_access_token: 'page-token' } });
    expect(integ.status).toBe(200);
    graph.handlers.set('GET 4444', () => ({
      json: {
        id: '4444', created_time: '2026-10-01T10:00:00+0000', form_id: '888', campaign_id: 'c-1', campaign_name: 'Lead Ads ADM Outubro', ad_name: 'Anúncio 1', adset_name: 'Público SP', platform: 'ig',
        field_data: [{ name: 'full_name', values: ['Fernanda Lima'] }, { name: 'phone_number', values: ['+5511944443333'] }, { name: 'email', values: ['fe@ex.com'] }, { name: 'qual_horario?', values: ['noite'] }],
      },
    }));
    const payload = { object: 'page', entry: [{ id: '777', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: '4444', page_id: '777', form_id: '888' } }] }] };
    const r = await postMetaWebhook(payload, 'app-secret-integracoes');
    expect(r.statusCode).toBe(200);
    await drainJobs();
    const lead = (await pool.query(`SELECT * FROM leads WHERE email='fe@ex.com'`)).rows[0];
    expect(lead.name).toBe('Fernanda Lima');
    expect(lead.source).toBe('Meta Lead Ads');
    expect(lead.utm_source).toBe('instagram');
    expect(lead.course_id).toBe(course.body.id);
    const camp = (await pool.query('SELECT * FROM campaigns WHERE id=$1', [lead.campaign_id])).rows[0];
    expect(camp.external_id).toBe('c-1');
    // reprocessar o mesmo leadgen não duplica
    await pool.query(`UPDATE jobs SET status='done'`);
    const { fetchAndIntakeLeadgen } = await import('../src/services/meta/leadAds.js');
    await fetchAndIntakeLeadgen({ leadgen_id: '4444', page_id: '777' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM leads WHERE email='fe@ex.com'`)).rows[0].n).toBe(1);
  });

  it('Meta Ads Insights: importa investimento e calcula CPL/ROAS com dados reais', async () => {
    graph.handlers.set('GET act_123/insights', () => ({ json: { data: [{ campaign_id: 'c-1', campaign_name: 'Lead Ads ADM Outubro', spend: '150.50', impressions: '1000', clicks: '40', date_start: '2026-10-01' }] } }));
    const integ = await admin.post('/api/integrations', { type: 'meta_ads_insights', name: 'Conta MF', config: { ad_account_id: '123' }, secrets: { access_token: 'ads-token' } });
    const s = await admin.post(`/api/integrations/${integ.body.id}/sync`, { days: 30 });
    expect(s.status).toBe(200);
    expect(s.body.rows).toBe(1);
    const mk = await admin.get('/api/reports/marketing?from=2026-09-01&to=2026-12-31');
    const camp = mk.body.data.campaigns.find((c: any) => c.name === 'Lead Ads ADM Outubro');
    expect(camp.spend).toBe(150.5);
    expect(camp.cpl).toBe(150.5);
    expect(camp.cpa).toBeNull();
  });

  it('webhook genérico de entrada com mapeamento de campos e HMAC', async () => {
    const integ = await admin.post('/api/integrations', { type: 'inbound_webhook', name: 'RD Station', config: { mapping: { name: 'lead.nome', phone: 'lead.cel' }, default_source: 'RD' }, secrets: { hmac_secret: 's3cr3t' } });
    const url = new URL(integ.body.webhook_url).pathname;
    const a = await getApp();
    const body = JSON.stringify({ lead: { nome: 'Gustavo', cel: '21987654321' }, utm_campaign: 'rd-nov' });
    const bad = await a.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-signature': 'errada' } });
    expect(bad.statusCode).toBe(401);
    const ok = await a.inject({ method: 'POST', url, payload: body, headers: { 'content-type': 'application/json', 'x-signature': hmacSha256Hex('s3cr3t', body) } });
    expect(ok.statusCode).toBe(202);
    await drainJobs();
    const lead = (await pool.query(`SELECT * FROM leads WHERE phone='5521987654321'`)).rows[0];
    expect(lead.name).toBe('Gustavo');
    expect(lead.source).toBe('RD');
    expect(lead.utm_campaign).toBe('rd-nov');
  });

  it('webhook de saída entrega eventos assinados e re-tenta em falha', async () => {
    const received: any[] = [];
    let fail = true;
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(b) });
        res.writeHead(fail ? 500 : 200).end();
        fail = false;
      });
    });
    await new Promise<void>((r) => srv.listen(47055, '127.0.0.1', () => r()));
    const integ = await admin.post('/api/integrations', { type: 'outbound_webhook', name: 'ERP', config: { url: 'http://127.0.0.1:47055/hook', events: ['lead.created'] } });
    const secret = integ.body.secret_once;
    await admin.post('/api/leads', { name: 'Evento Saída', phone: '11933332222', create_opportunity: false });
    await drainJobs();
    await pool.query(`UPDATE jobs SET run_at=now() WHERE status='pending'`);
    await drainJobs();
    srv.close();
    expect(received.length).toBe(2);
    const last = received[1];
    expect(last.body.event).toBe('lead.created');
    expect(last.body.lead.name).toBe('Evento Saída');
    const ts = last.headers['x-crm-timestamp'];
    expect(last.headers['x-crm-signature']).toBe(`sha256=${hmacSha256Hex(secret, `${ts}.${JSON.stringify(last.body)}`)}`);
  });
});
