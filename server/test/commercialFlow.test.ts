import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createUser, drainJobs, getApp, login, resetData } from './helpers.js';

/**
 * Fluxo comercial principal (item 13 do escopo):
 * formulário -> lead com origem/campanha -> deduplicação -> distribuição -> oportunidade -> notificação ->
 * etapa -> acompanhamento -> pendências -> matrícula com valor -> indicadores -> visão do gestor.
 */
describe('fluxo comercial de ponta a ponta', () => {
  let admin: Awaited<ReturnType<typeof login>>;
  let ana: Awaited<ReturnType<typeof login>>;
  let bruno: Awaited<ReturnType<typeof login>>;
  let anaId: number;
  let brunoId: number;
  let apiKey: string;
  let courseId: number;

  beforeAll(async () => {
    await getApp();
    await resetData();
    const a = await createUser('Admin Geral', 'admin');
    const s1 = await createUser('Ana Vendedora', 'seller');
    const s2 = await createUser('Bruno Vendedor', 'seller');
    anaId = s1.id;
    brunoId = s2.id;
    admin = await login(a.email);
    ana = await login(s1.email);
    bruno = await login(s2.email);
    const c = await admin.post('/api/courses', { name: 'Técnico em Informática', code: 'TEC-INFO', price: 2400, promo_price: 1990 });
    expect(c.status).toBe(200);
    courseId = c.body.id;
    const k = await admin.post('/api/api-keys', { name: 'Landing TI', allowed_origins: ['https://lp.microfacil.com.br'] });
    apiKey = k.body.key;
  });

  afterAll(async () => {
    await pool.query('SELECT 1');
  });

  let leadId: number;

  it('recebe o lead do formulário com origem, campanha e curso', async () => {
    const a = await getApp();
    const res = await a.inject({
      method: 'POST',
      url: '/api/public/leads',
      headers: { 'x-api-key': apiKey, origin: 'https://lp.microfacil.com.br', 'content-type': 'application/json' },
      payload: { nome: 'Maria Souza', telefone: '(11) 98765-4321', email: 'Maria@Exemplo.com', curso: 'TEC-INFO', utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'out-2026-ti', consent: true },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.created).toBe(true);
    leadId = body.lead_id;
    const lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    expect(lead.phone).toBe('5511987654321');
    expect(lead.email).toBe('maria@exemplo.com');
    expect(lead.course_id).toBe(courseId);
    expect(lead.consent_whatsapp).toBe(true);
    const camp = (await pool.query('SELECT * FROM campaigns WHERE id=$1', [lead.campaign_id])).rows[0];
    expect(camp.utm_campaign).toBe('out-2026-ti');
  });

  it('rejeita origem não autorizada e chave inválida', async () => {
    const a = await getApp();
    const bad = await a.inject({ method: 'POST', url: '/api/public/leads', headers: { 'x-api-key': apiKey, origin: 'https://site-estranho.com' }, payload: { nome: 'X', telefone: '11999990000' } });
    expect(bad.statusCode).toBe(403);
    const noKey = await a.inject({ method: 'POST', url: '/api/public/leads', payload: { nome: 'X', telefone: '11999990000' } });
    expect(noKey.statusCode).toBe(401);
  });

  it('distribui para um vendedor, cria oportunidade, tarefa de primeiro contato e notifica', async () => {
    const lead = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [leadId])).rows[0];
    expect([anaId, brunoId]).toContain(lead.owner_id);
    const opps = (await pool.query('SELECT * FROM opportunities WHERE lead_id=$1', [leadId])).rows;
    expect(opps).toHaveLength(1);
    expect(Number(opps[0].value)).toBe(1990); // preço promocional vigente
    expect(opps[0].owner_id).toBe(lead.owner_id);
    const task = (await pool.query(`SELECT * FROM tasks WHERE lead_id=$1 AND type='first_contact'`, [leadId])).rows;
    expect(task).toHaveLength(1);
    expect(task[0].assignee_id).toBe(lead.owner_id);
    const notif = (await pool.query(`SELECT * FROM notifications WHERE user_id=$1 AND type='lead.new'`, [lead.owner_id])).rows;
    expect(notif.length).toBeGreaterThan(0);
  });

  it('não duplica o lead quando o mesmo contato envia o formulário novamente (variação do 9º dígito)', async () => {
    const a = await getApp();
    const res = await a.inject({
      method: 'POST',
      url: '/api/public/leads',
      headers: { 'x-api-key': apiKey },
      payload: { nome: 'Maria S.', telefone: '+55 11 8765-4321', curso: 'TEC-INFO' },
    });
    const body = JSON.parse(res.body);
    expect(body.created).toBe(false);
    expect(body.lead_id).toBe(leadId);
    const count = (await pool.query(`SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL`)).rows[0].n;
    expect(count).toBe(1);
    // mesma oportunidade aberta para o mesmo curso: não cria outra
    const opps = (await pool.query('SELECT count(*)::int AS n FROM opportunities WHERE lead_id=$1', [leadId])).rows[0].n;
    expect(opps).toBe(1);
    const ev = (await pool.query(`SELECT * FROM lead_events WHERE lead_id=$1 AND type='reentry'`, [leadId])).rows;
    expect(ev).toHaveLength(1);
  });

  it('idempotência: a mesma Idempotency-Key retorna a mesma resposta', async () => {
    const a = await getApp();
    const send = () => a.inject({ method: 'POST', url: '/api/public/leads', headers: { 'x-api-key': apiKey, 'idempotency-key': 'abc-123' }, payload: { nome: 'Carlos', telefone: '21991112222' } });
    const r1 = JSON.parse((await send()).body);
    const r2 = JSON.parse((await send()).body);
    expect(r2.lead_id).toBe(r1.lead_id);
    expect(r2.duplicate).toBe(true);
  });

  it('vendedor só enxerga os próprios leads', async () => {
    const owner = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [leadId])).rows[0].owner_id;
    const ownerClient = owner === anaId ? ana : bruno;
    const other = owner === anaId ? bruno : ana;
    expect((await ownerClient.get(`/api/leads/${leadId}`)).status).toBe(200);
    expect((await other.get(`/api/leads/${leadId}`)).status).toBe(403);
    const list = await other.get('/api/leads');
    expect(list.body.rows.find((l: any) => l.id === leadId)).toBeUndefined();
    // vendedor não pode trocar o responsável nem acessar administração
    expect((await ownerClient.patch(`/api/leads/${leadId}`, { owner_id: owner === anaId ? brunoId : anaId })).status).toBe(403);
    expect((await ownerClient.post('/api/users', { name: 'X', email: 'x@x.com', role: 'admin', password: 'Senha1234' })).status).toBe(403);
    expect((await ownerClient.get('/api/audit')).status).toBe(403);
  });

  it('vendedor atende: registra contato, muda etapa, agenda retorno e conclui a tarefa', async () => {
    const owner = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [leadId])).rows[0].owner_id;
    const seller = owner === anaId ? ana : bruno;
    const c = await seller.post(`/api/leads/${leadId}/contact`, { channel: 'call', reached: true, outcome: 'Interessada, pediu proposta' });
    expect(c.status).toBe(200);
    let lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    expect(lead.first_contact_at).not.toBeNull();
    expect(lead.status).toBe('in_progress');

    const opp = (await pool.query('SELECT * FROM opportunities WHERE lead_id=$1', [leadId])).rows[0];
    const stages = (await pool.query(`SELECT * FROM pipeline_stages WHERE pipeline_id=$1 ORDER BY position`, [opp.pipeline_id])).rows;
    const proposta = stages.find((s) => s.name === 'Proposta apresentada');
    const mv = await seller.post(`/api/opportunities/${opp.id}/move`, { stage_id: proposta.id });
    expect(mv.status).toBe(200);
    const hist = (await pool.query('SELECT * FROM opportunity_stage_history WHERE opportunity_id=$1 ORDER BY id', [opp.id])).rows;
    expect(hist).toHaveLength(2);
    expect(hist[1].to_stage_id).toBe(proposta.id);

    const due = new Date(Date.now() - 60_000).toISOString(); // retorno já vencido -> deve aparecer como pendência
    const t = await seller.post('/api/tasks', { type: 'followup', title: 'Retornar com proposta', lead_id: leadId, opportunity_id: opp.id, due_at: due });
    expect(t.status).toBe(200);
    const summary = await seller.get(`/api/tasks/summary?assignee_id=${owner}`);
    expect(summary.body.overdue).toBeGreaterThanOrEqual(1);

    const first = (await pool.query(`SELECT id FROM tasks WHERE lead_id=$1 AND type='first_contact'`, [leadId])).rows[0];
    const done = await seller.post(`/api/tasks/${first.id}/complete`, { outcome: 'Contato feito' });
    expect(done.status).toBe(200);
    lead = (await pool.query('SELECT * FROM leads WHERE id=$1', [leadId])).rows[0];
    expect(lead.last_interaction_at).not.toBeNull();
  });

  it('não permite ganhar sem valor e registra a matrícula com o valor da venda', async () => {
    const owner = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [leadId])).rows[0].owner_id;
    const seller = owner === anaId ? ana : bruno;
    const opp = (await pool.query('SELECT * FROM opportunities WHERE lead_id=$1', [leadId])).rows[0];
    const lostStage = (await pool.query(`SELECT id FROM pipeline_stages WHERE pipeline_id=$1 AND kind='lost'`, [opp.pipeline_id])).rows[0];
    const noReason = await seller.post(`/api/opportunities/${opp.id}/move`, { stage_id: lostStage.id });
    expect(noReason.status).toBe(400);
    const win = await seller.post(`/api/opportunities/${opp.id}/win`, { sale_value: 1850 });
    expect(win.status).toBe(200);
    const after = (await pool.query('SELECT * FROM opportunities WHERE id=$1', [opp.id])).rows[0];
    expect(after.status).toBe('won');
    expect(Number(after.sale_value)).toBe(1850);
    const lead = (await pool.query('SELECT status FROM leads WHERE id=$1', [leadId])).rows[0];
    expect(lead.status).toBe('customer');
    // gestores notificados da venda
    const n = (await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE type='opportunity.won'`)).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });

  it('indicadores refletem os dados reais (central e relatórios)', async () => {
    await drainJobs();
    const d = await admin.get('/api/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.kpis.new_leads).toBe(2); // Maria + Carlos
    expect(d.body.kpis.sales).toBe(1);
    expect(d.body.kpis.revenue).toBe(1850);
    expect(d.body.kpis.avg_ticket).toBe(1850);
    expect(d.body.kpis.conversion_rate).toBe(50);
    const owner = (await pool.query('SELECT owner_id FROM leads WHERE id=$1', [leadId])).rows[0].owner_id;
    const seller = d.body.sellers.find((s: any) => s.id === owner);
    expect(seller.sales).toBe(1);
    expect(seller.revenue).toBe(1850);

    const vendas = await admin.get('/api/reports/vendas');
    expect(vendas.body.data.byCourse[0]).toMatchObject({ course: 'Técnico em Informática', sales: 1, revenue: 1850 });
    expect(vendas.body.data.byCampaign.find((c: any) => c.campaign === 'out-2026-ti').sales).toBe(1);
    const mk = await admin.get('/api/reports/marketing');
    const camp = mk.body.data.campaigns.find((c: any) => c.name === 'out-2026-ti');
    expect(camp.leads).toBe(1);
    expect(camp.cpl).toBeNull(); // sem investimento registrado, nada é inventado
    for (const r of ['captacao', 'atendimento', 'funil']) {
      expect((await admin.get(`/api/reports/${r}`)).status).toBe(200);
    }
    // vendedor vê apenas seus números
    const other = owner === anaId ? bruno : ana;
    const od = await other.get('/api/dashboard');
    expect(od.body.kpis.sales).toBe(0);
  });

  it('exporta relatórios em CSV e Excel', async () => {
    const csv = await admin.get('/api/reports/vendas/export?format=csv');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    const xlsx = await admin.get('/api/leads/export?format=xlsx');
    expect(xlsx.status).toBe(200);
    expect(String(xlsx.headers['content-type'])).toContain('spreadsheetml');
  });

  it('linha do tempo do lead registra todo o histórico', async () => {
    const t = await admin.get(`/api/leads/${leadId}/timeline?limit=200`);
    const types = t.body.rows.map((e: any) => e.type);
    for (const ty of ['created', 'owner_changed', 'opportunity_created', 'reentry', 'contact_logged', 'stage_changed', 'task_created', 'task_done', 'opportunity_won']) {
      expect(types).toContain(ty);
    }
  });

  it('auditoria registra alterações importantes', async () => {
    const a = await admin.get('/api/audit?action=opportunity.won');
    expect(a.body.total).toBeGreaterThan(0);
  });
});
