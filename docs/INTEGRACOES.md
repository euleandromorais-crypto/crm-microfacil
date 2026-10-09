# Integrações

> **Situação honesta:** todas as integrações estão implementadas e foram testadas com testes automatizados que simulam a Graph API
> da Meta e os webhooks com os formatos documentados. **Nenhuma foi testada com credenciais reais** neste ambiente de desenvolvimento.
> A seção “O que falta para ativar” lista exatamente o que é necessário para ligar cada uma em produção.

URL base usada abaixo: `https://crm.seudominio.com.br`.

## 1. App da Meta (base do WhatsApp e do Lead Ads)

1. Em [developers.facebook.com](https://developers.facebook.com) crie um App do tipo **Business** vinculado ao Gerenciador de Negócios da Micro Fácil.
2. Adicione os produtos **WhatsApp** e **Webhooks** (e **Facebook Login for Business** se for usar o cadastro incorporado).
3. No CRM: Integrações › WhatsApp › *App da Meta* — informe **App ID** e **App Secret**. O CRM exibe a **URL de callback** e o
   **token de verificação**.
4. No painel da Meta, em Webhooks:
   - Objeto **WhatsApp Business Account**: callback `https://crm.seudominio.com.br/webhooks/meta`, token de verificação do CRM;
     assine `messages`, `message_template_status_update`, `account_update`, `phone_number_quality_update` e, para coexistência,
     `smb_message_echoes`, `history`, `smb_app_state_sync`.
   - Objeto **Page**: mesma URL; assine `leadgen`.
5. Publique o app (modo Live) após concluir a **verificação da empresa** no Gerenciador de Negócios.

Todos os eventos recebidos são validados pela assinatura `X-Hub-Signature-256`; eventos sem assinatura válida são descartados.

## 2. WhatsApp Business Platform (Cloud API)

### Opção A — conexão manual (empresa operando o próprio app)
1. Em WhatsApp › Configuração da API, adicione e verifique o número (ou use um já registrado na Cloud API).
2. No Gerenciador de Negócios crie um **Usuário do Sistema** (admin), atribua o App e a conta do WhatsApp e gere um **token permanente**
   com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
3. No CRM: Integrações › WhatsApp › **Conectar manualmente** — informe Phone number ID, WABA ID e token. O CRM valida na Graph API,
   inscreve o app na WABA (`POST /{waba-id}/subscribed_apps`) e guarda o token criptografado.
4. Clique em **Sincronizar modelos** para importar os templates aprovados.

### Opção B — Embedded Signup (inclui coexistência)
1. Configure o **Facebook Login for Business** com uma configuração do tipo *WhatsApp Embedded Signup* e copie o **Configuration ID**.
2. Adicione o domínio do CRM aos domínios permitidos do app (Login com JavaScript SDK).
3. No CRM, informe o Configuration ID no App da Meta e use **Conectar via Meta (Embedded Signup)**.

### O que o CRM aplica das regras da plataforma
- **Janela de 24h**: mensagens livres só até 24h após a última mensagem do cliente; fora dela o compositor oferece apenas **modelos aprovados**
  (com preenchimento de variáveis). A regra é validada também no servidor.
- **Templates**: sincronizados da WABA, status atualizado pelo webhook `message_template_status_update`; só modelos `APPROVED` podem ser enviados.
- **Sem disparo em massa**: não existe envio em lote de WhatsApp. Automações enviam modelo somente a leads com consentimento registrado,
  uma vez por evento.
- **Mídia**: imagens (JPEG/PNG até 5 MB), áudio (até 16 MB), vídeo MP4/3GPP (até 16 MB) e documentos (até 100 MB). Mídias recebidas são
  baixadas e armazenadas localmente (as URLs da Meta expiram).
- **Status**: enviado/entregue/lido/falha pelos webhooks oficiais, aplicados em ordem (sem regressão quando chegam fora de ordem).
- **Falhas**: erros temporários (5xx, limite de taxa) são re-tentados automaticamente; erros definitivos aparecem na mensagem com o motivo
  e opção de reenvio.

### Coexistência (app WhatsApp Business no celular + Cloud API)
A Meta permite que um número que já usa o **app WhatsApp Business** seja conectado à Cloud API **sem deixar o app**, por meio do
Embedded Signup com `featureType: "whatsapp_business_app_onboarding"` (implementado no botão “Conectar via Meta”, opção *Coexistência*).

Implementado no CRM:
- Recebimento das mensagens enviadas pelo celular (`smb_message_echoes`) — aparecem no histórico como “enviada pelo celular” e encerram a
  espera de resposta.
- Importação do histórico (`history`, até ~6 meses, se a empresa autorizar no app) e sincronização de contatos (`smb_app_state_sync`),
  solicitadas pelos botões *Importar histórico* / *Sincronizar contatos* (`POST /{phone-number-id}/smb_app_data` com
  `sync_type` = `history` ou `smb_app_state_sync`). A Meta envia os dados em lotes via webhook.
- No onboarding de coexistência o CRM **não** chama o registro (`/register`) do número, que continua no app.

Requisitos e limitações (verificar elegibilidade com a Meta antes de migrar o número principal):
- App WhatsApp Business atualizado, conta no Gerenciador de Negócios, país suportado e empresa verificada.
- A sincronização de histórico/contatos deve ser solicitada logo após o onboarding (janela limitada definida pela Meta).
- Aparelhos acompanhantes não suportados podem ser desconectados no onboarding; mensagens enviadas por eles não geram echoes.
- Recursos como mensagens temporárias e alguns tipos de mídia do app podem não ser espelhados. Consulte a documentação oficial
  “Onboard WhatsApp Business app users” antes de ativar.

## 3. Meta Lead Ads
1. Em Integrações › Meta Lead Ads, adicione a integração com os **IDs das páginas** e um **token de página** de longa duração
   (ou de Usuário do Sistema) com `leads_retrieval`, `pages_manage_metadata`, `pages_show_list` e `pages_read_engagement`.
2. Clique em **Inscrever páginas no webhook** (campo `leadgen`).
3. Opcional: associe cada formulário a um curso (`ID_DO_FORMULARIO=ID_DO_CURSO`).

Fluxo: webhook `leadgen` → busca do lead na Graph API → mapeamento (nome, telefone, e-mail, demais respostas no histórico) →
deduplicação, distribuição, oportunidade e tarefa. A campanha do anúncio é vinculada pelo ID (útil para CPL/ROAS com Ads Insights).
**Recuperação:** se o webhook ficar indisponível, use *Recuperar leads* informando o ID do formulário e o número de dias.

## 4. Meta Ads Insights (investimento)
Adicione a integração com o **ID da conta de anúncios** e token com `ads_read`. O CRM importa diariamente o gasto por campanha
(últimos 7 dias, para capturar ajustes) e permite sincronizar 30 dias sob demanda. Sem essa integração, o investimento pode ser
lançado manualmente em Administração › Campanhas. CPL, CPA e ROAS só são exibidos com investimento registrado.

## 5. Formulários das landing pages / API de captação
- Endpoint: `POST https://crm.seudominio.com.br/api/public/leads` (JSON ou `application/x-www-form-urlencoded`).
- Autenticação: cabeçalho `X-Api-Key` (crie em Integrações › Formulários e API; restrinja às origens das landing pages).
- Campos: `nome`/`name`, `telefone`/`phone`/`whatsapp`, `email`, `curso` (código ou nome) ou `course_id`, `source`, `campaign`,
  `city`, `state`, `mensagem`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `page_url`, `external_id`,
  `consent`, `custom` (objeto com campos personalizados). Campos extras são guardados no histórico do lead.
- Idempotência: envie `Idempotency-Key` (ou `external_id`) para que reenvios não dupliquem.
- Respostas: `201 {lead_id, created:true}` (novo), `200 {created:false}` (contato já existente, dados completados), `4xx` com mensagem.
- O exemplo pronto de formulário (com captura automática de UTMs e honeypot anti-spam) está na própria tela de Integrações.

```bash
curl -X POST https://crm.seudominio.com.br/api/public/leads \
  -H 'Content-Type: application/json' -H 'X-Api-Key: crm_xxx' \
  -d '{"nome":"Maria","telefone":"11987654321","curso":"TEC-INFO","utm_source":"google","consent":true}'
```

## 6. Webhooks de entrada (ferramentas externas)
Para ferramentas que enviam leads por webhook (RD Station, n8n, Zapier, Make, Typeform…): Integrações › Webhooks › *Webhook de entrada*.
Cada integração recebe uma URL secreta (`/webhooks/in/<token>`, rotacionável), mapeamento de campos por caminho (`{"name":"data.nome"}`),
origem e curso padrão e, opcionalmente, validação HMAC (`X-Signature`). Eventos são gravados e processados com novas tentativas;
duplicados (mesmo corpo ou `Idempotency-Key`) são ignorados.

## 7. Webhooks de saída
Notificam outros sistemas (ERP, secretaria, planilhas) sobre: lead criado, status/responsável alterado, oportunidade criada/movida/ganha/perdida,
atendimento encerrado e atividade concluída. Corpo JSON com dados mínimos do lead e da oportunidade, cabeçalhos `X-CRM-Event`,
`X-CRM-Timestamp` e `X-CRM-Signature: sha256=HMAC(segredo, "timestamp.corpo")`. Até 8 tentativas com backoff.

## O que falta para ativar (checklist)

| Integração | Necessário (externo ao sistema) |
|---|---|
| Todas da Meta | App Meta tipo Business, **verificação da empresa**, app em modo Live, HTTPS público no domínio do CRM |
| WhatsApp (manual) | Número registrado na Cloud API, Phone number ID, WABA ID, token permanente de Usuário do Sistema com `whatsapp_business_messaging` e `whatsapp_business_management`, forma de pagamento na WABA (conversas cobradas pela Meta), modelos criados e aprovados no Gerenciador do WhatsApp |
| Coexistência | Configuração de Embedded Signup (Configuration ID) com acesso avançado às permissões do WhatsApp aprovado pela Meta (App Review) quando o app atende terceiros; número elegível no app WhatsApp Business |
| Lead Ads | IDs das páginas, token com `leads_retrieval` + `pages_manage_metadata` (App Review/acesso avançado), página vinculada ao app |
| Ads Insights | ID da conta de anúncios, token com `ads_read` |
| Landing pages | Inserir o formulário/script com a chave de API e configurar as origens permitidas |
| E-mail | Credenciais SMTP (opcional) |

Após configurar, use os botões **Testar** de cada integração e acompanhe **Logs e eventos**.
