import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { CourseSelect } from '../components/forms';
import { Badge, CopyField, ErrorBox, Field, Loading, Modal, Tabs, useConfirm, useToast } from '../components/ui';
import { fmtDateTime, relative } from '../format';
import { useCourses } from '../hooks';

const STATUS: Record<string, string> = { connected: 'Conectado', error: 'Com erro', pending: 'Pendente', disabled: 'Desativado' };
const Dot = ({ s }: { s: string }) => <span className="row" style={{ gap: 6 }}><span className={`status-dot ${s}`} />{STATUS[s] ?? s}</span>;

export default function Integrations() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<'whatsapp' | 'meta' | 'capture' | 'webhooks' | 'logs'>('whatsapp');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['integrations'], queryFn: () => api.get('/api/integrations/overview') });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={refetch} />;
  const errCount = (key: string) => data.errors24h.filter((e: any) => e.integration === key || e.integration.startsWith(`${key}:`)).reduce((a: number, e: any) => a + e.n, 0);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Integrações</h1>
        <span className="sub">As integrações são independentes: se uma ficar indisponível, o CRM continua operando normalmente.</span>
      </div>
      <div className="kpis">
        <div className="card kpi"><div className="label">App da Meta</div><div className="value" style={{ fontSize: 16 }}>{data.meta_app.configured ? <Dot s="connected" /> : <Dot s="pending" />}</div></div>
        <div className="card kpi"><div className="label">Contas WhatsApp</div><div className="value">{data.accounts.length}</div><div className="foot">{data.accounts.filter((a: any) => a.status === 'connected').length} conectadas · {errCount('whatsapp')} erros 24h</div></div>
        <div className="card kpi"><div className="label">Webhooks recebidos (24h)</div><div className="value">{data.webhookStats.last24h}</div><div className="foot">último {relative(data.webhookStats.last_received_at)}</div></div>
        <div className="card kpi" style={data.webhookStats.failed || data.webhookStats.stuck ? { borderColor: '#fca5a5' } : undefined}><div className="label">Eventos com falha</div><div className="value">{data.webhookStats.failed}</div><div className="foot">{data.webhookStats.stuck} aguardando processamento</div></div>
        <div className="card kpi" style={data.jobs.failed ? { borderColor: '#fca5a5' } : undefined}><div className="label">Fila de processamento</div><div className="value">{data.jobs.failed}</div><div className="foot">falhas · {data.jobs.delayed} atrasados</div></div>
      </div>
      <Tabs value={tab} onChange={setTab} items={[
        { value: 'whatsapp', label: 'WhatsApp' }, { value: 'meta', label: 'Meta Lead Ads / Ads' }, { value: 'capture', label: 'Formulários e API' },
        { value: 'webhooks', label: 'Webhooks' }, { value: 'logs', label: 'Logs e eventos' },
      ]} />
      {tab === 'whatsapp' && <WhatsAppTab data={data} isAdmin={isAdmin} />}
      {tab === 'meta' && <MetaTab data={data} isAdmin={isAdmin} />}
      {tab === 'capture' && <CaptureTab data={data} isAdmin={isAdmin} />}
      {tab === 'webhooks' && <WebhooksTab data={data} isAdmin={isAdmin} />}
      {tab === 'logs' && <LogsTab isAdmin={isAdmin} />}
    </div>
  );
}

function useAct() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (fn: () => Promise<any>, ok?: string | ((r: any) => string)) => {
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      qc.invalidateQueries({ queryKey: ['integrations'] });
      qc.invalidateQueries({ queryKey: ['wa-accounts'] });
      return r;
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    }
  };
}

function MetaAppCard({ data, isAdmin }: { data: any; isAdmin: boolean }) {
  const act = useAct();
  const [f, setF] = useState({ app_id: data.meta_app.app_id ?? '', app_secret: '', verify_token: '', embedded_signup_config_id: data.meta_app.embedded_signup_config_id ?? '' });
  const save = (e: FormEvent) => {
    e.preventDefault();
    act(() => api.put('/api/integrations/meta-app', { app_id: f.app_id, app_secret: f.app_secret || undefined, verify_token: f.verify_token || undefined, embedded_signup_config_id: f.embedded_signup_config_id || null }), 'App da Meta salvo');
  };
  return (
    <div className="card">
      <div className="card-head"><h2>1. App da Meta (webhooks)</h2>{data.meta_app.configured ? <Dot s="connected" /> : <Dot s="pending" />}</div>
      <div className="card-pad stack">
        <div className="small muted">Um único App (developers.facebook.com) recebe os webhooks do WhatsApp e do Lead Ads. Configure no painel da Meta a URL de callback e o token de verificação abaixo, e assine os campos <span className="mono">messages</span>, <span className="mono">message_template_status_update</span>, <span className="mono">smb_message_echoes</span>, <span className="mono">history</span> e <span className="mono">smb_app_state_sync</span> (coexistência) e, para páginas, <span className="mono">leadgen</span>.</div>
        <Field label="URL de callback (webhook)"><CopyField value={data.meta_webhook_url} /></Field>
        {data.meta_app.verify_token && <Field label="Token de verificação"><CopyField value={data.meta_app.verify_token} /></Field>}
        {isAdmin && (
          <form className="form-grid" onSubmit={save}>
            <Field label="App ID"><input className="input" value={f.app_id} onChange={(e) => setF({ ...f, app_id: e.target.value })} required /></Field>
            <Field label="App Secret" hint={data.meta_app.app_secret ? `Atual: ${data.meta_app.app_secret} (deixe vazio para manter)` : 'Usado para validar a assinatura dos webhooks'}><input className="input" type="password" value={f.app_secret} onChange={(e) => setF({ ...f, app_secret: e.target.value })} autoComplete="off" /></Field>
            <Field label="Token de verificação (opcional)" hint="Gerado automaticamente se vazio"><input className="input" value={f.verify_token} onChange={(e) => setF({ ...f, verify_token: e.target.value })} /></Field>
            <Field label="Configuration ID do Embedded Signup" hint="Necessário para o cadastro incorporado / coexistência"><input className="input" value={f.embedded_signup_config_id} onChange={(e) => setF({ ...f, embedded_signup_config_id: e.target.value })} /></Field>
            <div className="full"><button className="btn primary">Salvar</button></div>
          </form>
        )}
      </div>
    </div>
  );
}

function WhatsAppTab({ data, isAdmin }: { data: any; isAdmin: boolean }) {
  const act = useAct();
  const confirm = useConfirm();
  const [modal, setModal] = useState<ReactNode>(null);
  return (
    <div className="stack">
      <MetaAppCard data={data} isAdmin={isAdmin} />
      <div className="card">
        <div className="card-head">
          <h2>2. Números de WhatsApp (Cloud API oficial)</h2>
          {isAdmin && <button className="btn" onClick={() => setModal(<EmbeddedSignupModal onClose={() => setModal(null)} />)}>Conectar via Meta (Embedded Signup)</button>}
          {isAdmin && <button className="btn primary" onClick={() => setModal(<ManualAccountModal onClose={() => setModal(null)} />)}>+ Conectar manualmente</button>}
        </div>
        {!data.accounts.length && <div className="card-pad muted">Nenhum número conectado. O módulo de conversas funciona assim que um número for conectado com credenciais válidas.</div>}
        {data.accounts.map((a: any) => (
          <div key={a.id} className="task-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <div>
              <div className="cell-main">{a.name} · {a.display_phone ?? a.phone_number_id} {a.coexistence && <Badge color="violet">Coexistência (app + API)</Badge>}</div>
              <div className="cell-sub"><Dot s={a.status} /> {a.verified_name && `· ${a.verified_name}`} {a.quality_rating && `· qualidade ${a.quality_rating}`} · verificado {relative(a.last_check_at)} · WABA {a.waba_id} · Phone ID {a.phone_number_id}</div>
              {a.last_error && <div className="small" style={{ color: 'var(--danger)' }}>{a.last_error}</div>}
            </div>
            <div className="btn-row">
              <button className="btn sm" onClick={() => act(() => api.post(`/api/wa/accounts/${a.id}/test`), (r) => (r.ok ? `Conexão OK — ${r.info.display_phone_number}${r.webhookSubscribed ? '' : ' (webhooks NÃO inscritos)'}` : `Falhou: ${r.error}`))}>Testar</button>
              <button className="btn sm" onClick={() => act(() => api.post(`/api/wa/accounts/${a.id}/templates/sync`), (r) => `${r.count} modelo(s) sincronizado(s)`)}>Sincronizar modelos</button>
              {isAdmin && <button className="btn sm" onClick={() => act(() => api.post(`/api/wa/accounts/${a.id}/subscribe`), 'Webhooks reinscritos')}>Reconectar webhooks</button>}
              {isAdmin && a.coexistence && <button className="btn sm" onClick={() => act(() => api.post(`/api/wa/accounts/${a.id}/coexistence-sync`, { type: 'smb_app_state_sync' }), 'Sincronização de contatos solicitada')}>Sincronizar contatos</button>}
              {isAdmin && a.coexistence && <button className="btn sm" onClick={() => act(() => api.post(`/api/wa/accounts/${a.id}/coexistence-sync`, { type: 'history' }), 'Importação de histórico solicitada')}>Importar histórico</button>}
              {isAdmin && <button className="btn sm" onClick={() => setModal(<EditAccountModal account={a} onClose={() => setModal(null)} />)}>Editar</button>}
              {isAdmin && <button className="btn sm ghost" onClick={async () => (await confirm({ title: 'Remover/desativar número?', text: 'Se houver conversas, o número é apenas desativado e o histórico preservado.', danger: true })) && act(() => api.del(`/api/wa/accounts/${a.id}`), (r) => r.message ?? 'Removido')}>Remover</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="alert info small">
        <b>Regras da plataforma aplicadas pelo CRM:</b> mensagens livres só dentro da janela de 24h após a última mensagem do cliente; fora dela, apenas modelos aprovados.
        Automações só enviam modelos a leads com consentimento registrado e nunca em massa. Status de entrega/leitura vêm dos webhooks oficiais. Mensagens enviadas pelo app no celular (coexistência) aparecem no histórico como “enviada pelo celular”.
      </div>
      {modal}
    </div>
  );
}

function ManualAccountModal({ onClose }: { onClose: () => void }) {
  const act = useAct();
  const [f, setF] = useState({ name: 'WhatsApp Comercial', phone_number_id: '', waba_id: '', access_token: '', coexistence: false });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await act(() => api.post('/api/wa/accounts', f), (r) => (r.status === 'connected' ? 'Número conectado' : `Conectado com aviso: ${r.last_error}`));
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Modal title="Conectar número (Cloud API)" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="wa-form" disabled={busy}>{busy ? 'Validando na Meta...' : 'Conectar'}</button></>}>
      <form id="wa-form" className="stack" onSubmit={submit}>
        <div className="alert info small">Obtenha no Gerenciador de Negócios: ID do número (Phone number ID), ID da conta WhatsApp Business (WABA ID) e um <b>token permanente de Usuário do Sistema</b> com as permissões whatsapp_business_messaging e whatsapp_business_management. As credenciais são validadas na Meta e armazenadas criptografadas.</div>
        <Field label="Nome interno"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Phone number ID"><input className="input" value={f.phone_number_id} onChange={(e) => setF({ ...f, phone_number_id: e.target.value.trim() })} required /></Field>
        <Field label="WABA ID"><input className="input" value={f.waba_id} onChange={(e) => setF({ ...f, waba_id: e.target.value.trim() })} required /></Field>
        <Field label="Token de acesso"><input className="input" type="password" autoComplete="off" value={f.access_token} onChange={(e) => setF({ ...f, access_token: e.target.value.trim() })} required /></Field>
        <label className="check"><input type="checkbox" checked={f.coexistence} onChange={(e) => setF({ ...f, coexistence: e.target.checked })} /> Número em coexistência (também usado no app WhatsApp Business do celular)</label>
      </form>
    </Modal>
  );
}

function EditAccountModal({ account, onClose }: { account: any; onClose: () => void }) {
  const act = useAct();
  const [f, setF] = useState({ name: account.name, coexistence: account.coexistence, access_token: '', disabled: account.status === 'disabled' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act(() => api.patch(`/api/wa/accounts/${account.id}`, { name: f.name, coexistence: f.coexistence, access_token: f.access_token || undefined, disabled: f.disabled }), 'Conta atualizada');
    if (r) onClose();
  };
  return (
    <Modal title="Editar número" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="wa-edit">Salvar</button></>}>
      <form id="wa-edit" className="stack" onSubmit={submit}>
        <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Novo token de acesso" hint="Deixe vazio para manter o atual"><input className="input" type="password" autoComplete="off" value={f.access_token} onChange={(e) => setF({ ...f, access_token: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.coexistence} onChange={(e) => setF({ ...f, coexistence: e.target.checked })} /> Coexistência com o app do celular</label>
        <label className="check"><input type="checkbox" checked={f.disabled} onChange={(e) => setF({ ...f, disabled: e.target.checked })} /> Desativar envio por este número</label>
      </form>
    </Modal>
  );
}

declare global {
  interface Window { FB?: any; fbAsyncInit?: () => void }
}

function loadFbSdk(appId: string, version: string) {
  return new Promise<void>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      return resolve();
    }
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/pt_BR/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Não foi possível carregar o SDK da Meta'));
    document.body.appendChild(s);
  });
}

function EmbeddedSignupModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const act = useAct();
  const { data: cfg } = useQuery({ queryKey: ['es-config'], queryFn: () => api.get('/api/integrations/embedded-signup-config') });
  const [coex, setCoex] = useState(true);
  const [pin, setPin] = useState('');
  const [name, setName] = useState('WhatsApp Comercial');
  const [status, setStatus] = useState('');
  const start = async () => {
    if (!cfg?.app_id || !cfg?.config_id) return toast('Configure App ID e Configuration ID do Embedded Signup no App da Meta', 'error');
    try {
      await loadFbSdk(cfg.app_id, cfg.graph_version);
    } catch (err) {
      return toast((err as Error).message, 'error');
    }
    let session: { waba_id?: string; phone_number_id?: string } = {};
    const onMsg = (event: MessageEvent) => {
      if (!/facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const d = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (d?.type === 'WA_EMBEDDED_SIGNUP') {
          if (d.event?.startsWith('FINISH')) session = { waba_id: d.data?.waba_id, phone_number_id: d.data?.phone_number_id };
          else if (d.event === 'CANCEL') setStatus(`Cadastro cancelado na etapa: ${d.data?.current_step ?? '—'}`);
          else if (d.event === 'ERROR') setStatus(`Erro informado pela Meta: ${d.data?.error_message ?? ''}`);
        }
      } catch {
        /* mensagens não relacionadas */
      }
    };
    window.addEventListener('message', onMsg);
    setStatus('Conclua o fluxo na janela da Meta...');
    window.FB.login(
      (resp: any) => {
        window.removeEventListener('message', onMsg);
        const code = resp?.authResponse?.code;
        if (!code) return setStatus('Autorização não concluída.');
        if (!session.waba_id || !session.phone_number_id) return setStatus('A Meta não retornou WABA/número. Verifique a configuração do Embedded Signup (sessionInfoVersion 3).');
        setStatus('Finalizando conexão...');
        act(() => api.post('/api/wa/embedded-signup', { code, ...session, coexistence: coex, pin: coex ? null : pin, name }), 'Número conectado').then((r) => r && onClose());
      },
      { config_id: cfg.config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: coex ? 'whatsapp_business_app_onboarding' : '', sessionInfoVersion: '3' } },
    );
  };
  return (
    <Modal title="Conectar via Embedded Signup da Meta" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Fechar</button><button className="btn primary" onClick={start}>Iniciar com Facebook</button></>}>
      <div className="stack">
        <div className="alert info small">
          O cadastro incorporado conecta o número à Cloud API. Na <b>coexistência</b>, o mesmo número continua funcionando no app WhatsApp Business do celular e as conversas passam a ser espelhadas no CRM (mensagens enviadas pelo celular chegam como “echoes”; o histórico de até 6 meses pode ser importado nas primeiras 24h).
          Requer App da Meta com Embedded Signup configurado (Facebook Login for Business), verificação da empresa e número elegível (app WhatsApp Business atualizado, em país suportado).
        </div>
        <Field label="Nome interno"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={coex} onChange={(e) => setCoex(e.target.checked)} /> Coexistência: manter o número no app WhatsApp Business do celular</label>
        {!coex && <Field label="PIN de verificação em duas etapas (6 dígitos)" hint="Usado para registrar o número na Cloud API"><input className="input" value={pin} maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field>}
        {status && <div className="alert warn">{status}</div>}
      </div>
    </Modal>
  );
}

function IntegrationRow({ i, isAdmin, onEdit, children }: { i: any; isAdmin: boolean; onEdit: () => void; children?: ReactNode }) {
  const act = useAct();
  const confirm = useConfirm();
  return (
    <div className="task-row" style={{ gridTemplateColumns: '1fr auto' }}>
      <div>
        <div className="cell-main">{i.name} {!i.active && <Badge>inativa</Badge>}</div>
        <div className="cell-sub"><Dot s={i.status} /> · último sucesso {relative(i.last_success_at)}</div>
        {i.last_error && i.status === 'error' && <div className="small" style={{ color: 'var(--danger)' }}>{i.last_error}</div>}
        {children}
      </div>
      <div className="btn-row">
        <button className="btn sm" onClick={() => act(() => api.post(`/api/integrations/${i.id}/test`), (r) => (r.ok ? `Teste OK${r.detail ? `: ${JSON.stringify(r.detail).slice(0, 160)}` : ''}` : `Falhou: ${r.error}`))}>Testar</button>
        {isAdmin && <button className="btn sm" onClick={onEdit}>Editar</button>}
        {isAdmin && <button className="btn sm ghost" onClick={async () => (await confirm({ title: 'Excluir integração?', text: i.name, danger: true })) && act(() => api.del(`/api/integrations/${i.id}`), 'Integração excluída')}>Excluir</button>}
      </div>
    </div>
  );
}

function MetaTab({ data, isAdmin }: { data: any; isAdmin: boolean }) {
  const act = useAct();
  const [modal, setModal] = useState<ReactNode>(null);
  const [backfill, setBackfill] = useState({ form_id: '', days: 7 });
  const leadAds = data.integrations.filter((i: any) => i.type === 'meta_lead_ads');
  const ads = data.integrations.filter((i: any) => i.type === 'meta_ads_insights');
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Meta Lead Ads (formulários de anúncios)</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<IntegrationForm type="meta_lead_ads" onClose={() => setModal(null)} />)}>+ Adicionar</button>}</div>
        <div className="card-pad small muted">Os leads chegam pelo webhook <span className="mono">leadgen</span> do App da Meta (aba WhatsApp › App da Meta) e são buscados com o token da página. Requer permissões leads_retrieval, pages_manage_metadata e pages_show_list.</div>
        {leadAds.map((i: any) => (
          <IntegrationRow key={i.id} i={i} isAdmin={isAdmin} onEdit={() => setModal(<IntegrationForm type="meta_lead_ads" integration={i} onClose={() => setModal(null)} />)}>
            <div className="small">Páginas: {(i.config.page_ids ?? []).join(', ') || '—'}</div>
            {isAdmin && (
              <div className="row wrap" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={() => act(() => api.post(`/api/integrations/${i.id}/subscribe-pages`), (r) => r.map((x: any) => `${x.page}: ${x.ok ? 'inscrita' : x.error}`).join(' · '))}>Inscrever páginas no webhook</button>
                <input className="input sm" style={{ width: 160 }} placeholder="ID do formulário" value={backfill.form_id} onChange={(e) => setBackfill({ ...backfill, form_id: e.target.value })} />
                <input className="input sm" style={{ width: 70 }} type="number" min={1} max={90} value={backfill.days} onChange={(e) => setBackfill({ ...backfill, days: Number(e.target.value) })} />
                <button className="btn sm" disabled={!backfill.form_id} onClick={() => act(() => api.post(`/api/integrations/${i.id}/backfill`, backfill), (r) => `${r.queued} lead(s) enfileirados para importação`)}>Recuperar leads (dias)</button>
              </div>
            )}
          </IntegrationRow>
        ))}
        {!leadAds.length && <div className="card-pad muted">Nenhuma integração configurada.</div>}
      </div>
      <div className="card">
        <div className="card-head"><h2>Meta Ads Insights (investimento)</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<IntegrationForm type="meta_ads_insights" onClose={() => setModal(null)} />)}>+ Adicionar</button>}</div>
        <div className="card-pad small muted">Importa diariamente o investimento por campanha para calcular CPL, CPA e ROAS com dados reais. Requer token com permissão ads_read.</div>
        {ads.map((i: any) => (
          <IntegrationRow key={i.id} i={i} isAdmin={isAdmin} onEdit={() => setModal(<IntegrationForm type="meta_ads_insights" integration={i} onClose={() => setModal(null)} />)}>
            <div className="small">Conta: act_{String(i.config.ad_account_id).replace(/^act_/, '')} <button className="btn sm" onClick={() => act(() => api.post(`/api/integrations/${i.id}/sync`, { days: 30 }), (r) => `${r.rows} registros diários importados`)}>Sincronizar 30 dias</button></div>
          </IntegrationRow>
        ))}
        {!ads.length && <div className="card-pad muted">Nenhuma integração configurada. Também é possível lançar investimento manualmente em Configurações › Campanhas.</div>}
      </div>
      {modal}
    </div>
  );
}

function CaptureTab({ data, isAdmin }: { data: any; isAdmin: boolean }) {
  const act = useAct();
  const confirm = useConfirm();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [modal, setModal] = useState<ReactNode>(null);
  const { data: keys, refetch } = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get('/api/api-keys'), enabled: isAdmin });
  const { data: courses } = useCourses();
  const snippet = `<form id="form-interesse">
  <input name="nome" required placeholder="Nome">
  <input name="telefone" required placeholder="WhatsApp">
  <input name="email" type="email" placeholder="E-mail">
  <input type="hidden" name="curso" value="${courses?.find((c) => c.code)?.code ?? 'CODIGO-DO-CURSO'}">
  <input name="website" style="display:none" tabindex="-1" autocomplete="off"><!-- anti-spam -->
  <label><input type="checkbox" name="consent" value="true"> Aceito receber contato pelo WhatsApp</label>
  <button>Quero saber mais</button>
</form>
<script>
document.getElementById('form-interesse').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const p = new URLSearchParams(location.search);
  ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k => p.get(k) && (data[k] = p.get(k)));
  data.page_url = location.href;
  const r = await fetch('${data.public_leads_url}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'SUA_CHAVE' },
    body: JSON.stringify(data)
  });
  alert(r.ok ? 'Recebemos seu interesse! Em breve entraremos em contato.' : 'Não foi possível enviar. Tente novamente.');
});
</script>`;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>API de captação de leads</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<KeyForm onClose={() => setModal(null)} onCreated={(k) => { setNewKey(k); refetch(); }} />)}>+ Nova chave</button>}</div>
        <div className="card-pad stack">
          <Field label="Endpoint (POST, JSON ou formulário)"><CopyField value={data.public_leads_url} /></Field>
          <div className="small muted">Campos aceitos: nome/name, telefone/phone/whatsapp, email, curso (código ou nome) ou course_id, source, campaign, city, state, mensagem, utm_source, utm_medium, utm_campaign, utm_term, utm_content, page_url, external_id, consent, custom {'{...}'}. Envie <span className="mono">Idempotency-Key</span> para evitar duplicidade em reenvios. Leads com telefone/e-mail já existentes não são duplicados.</div>
          {newKey && <div className="alert success">Chave criada — copie agora, ela não será exibida novamente:<CopyField value={newKey} /></div>}
          {isAdmin && (
            <table className="table">
              <thead><tr><th>Nome</th><th>Prefixo</th><th>Origens permitidas</th><th>Origem padrão</th><th>Último uso</th><th /></tr></thead>
              <tbody>
                {keys?.map((k: any) => (
                  <tr key={k.id}>
                    <td>{k.name} {!k.active && <Badge>inativa</Badge>}</td>
                    <td className="mono">{k.prefix}…</td>
                    <td className="small">{k.allowed_origins.join(', ') || 'qualquer'}</td>
                    <td>{k.default_source ?? '—'}</td>
                    <td>{relative(k.last_used_at)}</td>
                    <td className="nowrap">
                      <button className="btn sm" onClick={() => act(() => api.patch(`/api/api-keys/${k.id}`, { active: !k.active }), k.active ? 'Chave desativada' : 'Chave ativada').then(() => refetch())}>{k.active ? 'Desativar' : 'Ativar'}</button>
                      <button className="btn sm ghost" onClick={async () => (await confirm({ title: 'Excluir chave?', text: 'Formulários que usam esta chave deixarão de enviar leads.', danger: true })) && act(() => api.del(`/api/api-keys/${k.id}`), 'Chave excluída').then(() => refetch())}>Excluir</button>
                    </td>
                  </tr>
                ))}
                {keys && !keys.length && <tr><td colSpan={6} className="muted">Nenhuma chave criada.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Exemplo para landing page</h2></div>
        <div className="card-pad"><div className="code">{snippet}</div><div className="small muted" style={{ marginTop: 8 }}>Restrinja a chave aos domínios das landing pages (origens permitidas). Para servidores/ferramentas (n8n, Zapier, RD etc.), use também o webhook de entrada (aba Webhooks).</div></div>
      </div>
      {modal}
    </div>
  );
}

function KeyForm({ onClose, onCreated }: { onClose: () => void; onCreated: (k: string) => void }) {
  const act = useAct();
  const [f, setF] = useState({ name: '', origins: '', default_source: 'Landing page', default_course_id: null as number | null });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act(() => api.post('/api/api-keys', { name: f.name, allowed_origins: f.origins.split(/[\s,]+/).filter(Boolean), default_source: f.default_source || null, default_course_id: f.default_course_id }));
    if (r) {
      onCreated(r.key);
      onClose();
    }
  };
  return (
    <Modal title="Nova chave de API" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="key-form">Criar</button></>}>
      <form id="key-form" className="stack" onSubmit={submit}>
        <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required placeholder="Ex.: Landing Técnico em Informática" /></Field>
        <Field label="Origens permitidas" hint="Ex.: https://www.microfacil.com.br (separe por vírgula). Vazio = qualquer origem (use apenas para servidores)."><input className="input" value={f.origins} onChange={(e) => setF({ ...f, origins: e.target.value })} /></Field>
        <Field label="Origem padrão do lead"><input className="input" value={f.default_source} onChange={(e) => setF({ ...f, default_source: e.target.value })} /></Field>
        <Field label="Curso padrão"><CourseSelect value={f.default_course_id} onChange={(v) => setF({ ...f, default_course_id: v })} /></Field>
      </form>
    </Modal>
  );
}

const OUT_EVENTS: Record<string, string> = {
  'lead.created': 'Lead criado', 'lead.status_changed': 'Status do lead alterado', 'lead.owner_changed': 'Responsável alterado', 'opportunity.created': 'Oportunidade criada',
  'opportunity.stage_changed': 'Mudança de etapa', 'opportunity.won': 'Matrícula realizada', 'opportunity.lost': 'Oportunidade perdida', 'conversation.closed': 'Atendimento encerrado', 'task.completed': 'Atividade concluída',
};

function IntegrationForm({ type, integration, onClose }: { type: string; integration?: any; onClose: () => void }) {
  const act = useAct();
  const { data: courses } = useCourses();
  const cfg = integration?.config ?? {};
  const [f, setF] = useState<any>({
    name: integration?.name ?? ({ meta_lead_ads: 'Lead Ads', meta_ads_insights: 'Meta Ads', inbound_webhook: 'Webhook de entrada', outbound_webhook: 'Webhook de saída' } as any)[type],
    active: integration?.active ?? true,
    page_ids: (cfg.page_ids ?? []).join(', '), default_course_id: cfg.default_course_id ?? null, form_courses: Object.entries(cfg.form_courses ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    ad_account_id: cfg.ad_account_id ?? '', url: cfg.url ?? '', events: cfg.events ?? ['lead.created', 'opportunity.won'], default_source: cfg.default_source ?? '',
    mapping: JSON.stringify(cfg.mapping ?? {}, null, 2), secret: '',
  });
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let config: any = {};
    let secrets: any = {};
    if (type === 'meta_lead_ads') {
      const fc = Object.fromEntries(f.form_courses.split('\n').map((l: string) => l.split('=').map((x) => x.trim())).filter((p: string[]) => p[0] && p[1]).map(([k, v]: string[]) => [k, Number(v)]));
      config = { page_ids: f.page_ids.split(/[\s,]+/).filter(Boolean), default_course_id: f.default_course_id, form_courses: fc };
      if (f.secret) secrets = { page_access_token: f.secret };
    } else if (type === 'meta_ads_insights') {
      config = { ad_account_id: f.ad_account_id.replace(/^act_/, '') };
      if (f.secret) secrets = { access_token: f.secret };
    } else if (type === 'outbound_webhook') {
      config = { url: f.url, events: f.events };
    } else if (type === 'inbound_webhook') {
      let mapping = {};
      try {
        mapping = JSON.parse(f.mapping || '{}');
      } catch {
        return act(async () => { throw new Error('Mapeamento JSON inválido'); });
      }
      config = { mapping, default_source: f.default_source || null, default_course_id: f.default_course_id };
      if (f.secret) secrets = { hmac_secret: f.secret };
    }
    const body = { name: f.name, active: f.active, config, secrets };
    const r = await act(() => (integration ? api.patch(`/api/integrations/${integration.id}`, body) : api.post('/api/integrations', { type, ...body })), 'Integração salva');
    if (r?.secret_once) setSecretOnce(r.secret_once);
    else if (r) onClose();
  };
  if (secretOnce) {
    return (
      <Modal title="Segredo de assinatura" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Concluir</button>}>
        <div className="stack"><div className="alert success">Use este segredo para validar o cabeçalho <span className="mono">X-CRM-Signature</span> (HMAC-SHA256 de “timestamp.corpo”). Ele não será exibido novamente.</div><CopyField value={secretOnce} /></div>
      </Modal>
    );
  }
  return (
    <Modal size="lg" title={integration ? `Editar: ${integration.name}` : 'Nova integração'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" form="int-form">Salvar</button></>}>
      <form id="int-form" className="form-grid" onSubmit={submit}>
        <Field label="Nome"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativa</label>
        {type === 'meta_lead_ads' && (
          <>
            <Field label="IDs das páginas do Facebook" className="full" hint="Separe por vírgula"><input className="input" value={f.page_ids} onChange={(e) => setF({ ...f, page_ids: e.target.value })} required /></Field>
            <Field label="Token de acesso da página" className="full" hint={integration?.secrets?.page_access_token ? `Atual: ${integration.secrets.page_access_token} (vazio = manter)` : 'Token de página de longa duração ou de Usuário do Sistema'}><input className="input" type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!integration} /></Field>
            <Field label="Curso padrão"><select className="select" value={f.default_course_id ?? ''} onChange={(e) => setF({ ...f, default_course_id: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Formulário → ID do curso" className="full" hint="Uma linha por formulário: 123456789=4"><textarea className="textarea mono" value={f.form_courses} onChange={(e) => setF({ ...f, form_courses: e.target.value })} /></Field>
          </>
        )}
        {type === 'meta_ads_insights' && (
          <>
            <Field label="ID da conta de anúncios" hint="Sem o prefixo act_"><input className="input" value={f.ad_account_id} onChange={(e) => setF({ ...f, ad_account_id: e.target.value })} required /></Field>
            <Field label="Token de acesso (ads_read)" hint={integration?.secrets?.access_token ? `Atual: ${integration.secrets.access_token}` : undefined}><input className="input" type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} required={!integration} /></Field>
          </>
        )}
        {type === 'outbound_webhook' && (
          <>
            <Field label="URL de destino (HTTPS)" className="full"><input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required /></Field>
            <div className="full">
              <b className="small">Eventos</b>
              <div className="row wrap" style={{ marginTop: 6 }}>{Object.entries(OUT_EVENTS).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={f.events.includes(k)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, k] : f.events.filter((x: string) => x !== k) })} /> {v}</label>)}</div>
            </div>
          </>
        )}
        {type === 'inbound_webhook' && (
          <>
            <Field label="Origem padrão"><input className="input" value={f.default_source} onChange={(e) => setF({ ...f, default_source: e.target.value })} /></Field>
            <Field label="Curso padrão"><select className="select" value={f.default_course_id ?? ''} onChange={(e) => setF({ ...f, default_course_id: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Mapeamento de campos (JSON)" className="full" hint='Campo do CRM → caminho no payload. Ex.: {"name": "data.nome", "phone": "data.celular", "course": "produto"}. Vazio = nomes comuns (nome, telefone, email, curso, utm_*).'><textarea className="textarea mono" rows={6} value={f.mapping} onChange={(e) => setF({ ...f, mapping: e.target.value })} /></Field>
            <Field label="Segredo HMAC (opcional)" className="full" hint="Se definido, exige cabeçalho X-Signature com HMAC-SHA256 do corpo"><input className="input" type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>
          </>
        )}
      </form>
    </Modal>
  );
}

function WebhooksTab({ data, isAdmin }: { data: any; isAdmin: boolean }) {
  const act = useAct();
  const [modal, setModal] = useState<ReactNode>(null);
  const inbound = data.integrations.filter((i: any) => i.type === 'inbound_webhook');
  const outbound = data.integrations.filter((i: any) => i.type === 'outbound_webhook');
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>Webhooks de entrada (receber leads)</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<IntegrationForm type="inbound_webhook" onClose={() => setModal(null)} />)}>+ Adicionar</button>}</div>
        {inbound.map((i: any) => (
          <IntegrationRow key={i.id} i={i} isAdmin={isAdmin} onEdit={() => setModal(<IntegrationForm type="inbound_webhook" integration={i} onClose={() => setModal(null)} />)}>
            <div style={{ marginTop: 6 }}><CopyField value={i.webhook_url} /></div>
            {isAdmin && <button className="btn sm" style={{ marginTop: 4 }} onClick={() => act(() => api.post(`/api/integrations/${i.id}/rotate`), 'Nova URL gerada (atualize nas ferramentas)')}>Gerar nova URL</button>}
          </IntegrationRow>
        ))}
        {!inbound.length && <div className="card-pad muted">Nenhum webhook de entrada.</div>}
      </div>
      <div className="card">
        <div className="card-head"><h2>Webhooks de saída (notificar outros sistemas)</h2>{isAdmin && <button className="btn primary" onClick={() => setModal(<IntegrationForm type="outbound_webhook" onClose={() => setModal(null)} />)}>+ Adicionar</button>}</div>
        {outbound.map((i: any) => (
          <IntegrationRow key={i.id} i={i} isAdmin={isAdmin} onEdit={() => setModal(<IntegrationForm type="outbound_webhook" integration={i} onClose={() => setModal(null)} />)}>
            <div className="small">{i.config.url} · {(i.config.events ?? []).map((e: string) => OUT_EVENTS[e]).join(', ')}</div>
            {isAdmin && <button className="btn sm" style={{ marginTop: 4 }} onClick={() => act(() => api.post(`/api/integrations/${i.id}/rotate`)).then((r) => r?.secret_once && setModal(<Modal title="Novo segredo" onClose={() => setModal(null)}><CopyField value={r.secret_once} /></Modal>))}>Rotacionar segredo</button>}
          </IntegrationRow>
        ))}
        {!outbound.length && <div className="card-pad muted">Nenhum webhook de saída.</div>}
      </div>
      {modal}
    </div>
  );
}

function LogsTab({ isAdmin }: { isAdmin: boolean }) {
  const act = useAct();
  const [level, setLevel] = useState('');
  const [view, setView] = useState<'logs' | 'events' | 'jobs'>('logs');
  const logs = useQuery({ queryKey: ['int-logs', level], queryFn: () => api.get('/api/integration-logs', { level, limit: 200 }), enabled: view === 'logs' });
  const events = useQuery({ queryKey: ['wh-events'], queryFn: () => api.get('/api/webhook-events', { limit: 200 }), enabled: view === 'events' && isAdmin });
  const jobs = useQuery({ queryKey: ['jobs-failed'], queryFn: () => api.get('/api/jobs', { status: 'failed' }), enabled: view === 'jobs' && isAdmin });
  return (
    <div className="card">
      <div className="card-head">
        <div className="btn-row">
          <button className={`btn sm ${view === 'logs' ? 'primary' : ''}`} onClick={() => setView('logs')}>Histórico / logs</button>
          {isAdmin && <button className={`btn sm ${view === 'events' ? 'primary' : ''}`} onClick={() => setView('events')}>Eventos de webhook</button>}
          {isAdmin && <button className={`btn sm ${view === 'jobs' ? 'primary' : ''}`} onClick={() => setView('jobs')}>Jobs com falha</button>}
        </div>
        <span className="spacer" />
        {view === 'logs' && <select className="select sm" style={{ width: 'auto' }} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Todos os níveis</option><option value="error">Erros</option><option value="warn">Avisos</option><option value="info">Informações</option></select>}
      </div>
      <div className="table-wrap" style={{ maxHeight: '60vh' }}>
        {view === 'logs' && (
          <table className="table"><thead><tr><th>Quando</th><th>Integração</th><th>Nível</th><th>Ação</th><th>Mensagem</th></tr></thead>
            <tbody>{logs.data?.map((l: any) => (
              <tr key={l.id}><td className="nowrap small">{fmtDateTime(l.created_at)}</td><td className="mono">{l.integration}</td><td><Badge color={l.level === 'error' ? 'red' : l.level === 'warn' ? 'amber' : 'gray'}>{l.level}</Badge></td><td className="small">{l.action}</td><td className="small">{l.message}</td></tr>
            ))}{logs.data && !logs.data.length && <tr><td colSpan={5} className="muted">Sem registros.</td></tr>}</tbody></table>
        )}
        {view === 'events' && (
          <table className="table"><thead><tr><th>Recebido</th><th>Origem</th><th>Status</th><th>Tentativas</th><th>Erro / conteúdo</th><th /></tr></thead>
            <tbody>{events.data?.map((e: any) => (
              <tr key={e.id}><td className="nowrap small">{fmtDateTime(e.received_at)}</td><td className="mono">{e.provider}</td><td><Badge color={e.status === 'processed' ? 'green' : e.status === 'failed' ? 'red' : 'amber'}>{e.status}</Badge></td><td>{e.attempts}</td>
                <td className="small"><div style={{ color: 'var(--danger)' }}>{e.error}</div><div className="mono muted ellipsis" style={{ maxWidth: 480 }}>{e.payload_preview}</div></td>
                <td>{e.status !== 'processed' && <button className="btn sm" onClick={() => act(() => api.post(`/api/webhook-events/${e.id}/reprocess`), 'Reprocessamento agendado').then(() => events.refetch())}>Reprocessar</button>}</td></tr>
            ))}</tbody></table>
        )}
        {view === 'jobs' && (
          <table className="table"><thead><tr><th>Job</th><th>Tipo</th><th>Tentativas</th><th>Último erro</th><th>Finalizado</th><th /></tr></thead>
            <tbody>{jobs.data?.map((j: any) => (
              <tr key={j.id}><td>#{j.id}</td><td className="mono">{j.type}</td><td>{j.attempts}/{j.max_attempts}</td><td className="small">{j.last_error}</td><td className="small">{fmtDateTime(j.finished_at)}</td>
                <td><button className="btn sm" onClick={() => act(() => api.post(`/api/jobs/${j.id}/retry`), 'Job reenfileirado').then(() => jobs.refetch())}>Tentar novamente</button></td></tr>
            ))}{jobs.data && !jobs.data.length && <tr><td colSpan={6} className="muted">Nenhum job com falha.</td></tr>}</tbody></table>
        )}
      </div>
    </div>
  );
}
