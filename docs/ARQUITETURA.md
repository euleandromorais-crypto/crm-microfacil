# Arquitetura

## Visão geral

```
                 ┌──────────────── VPS Hostinger (Ubuntu) ────────────────┐
 Navegador ──HTTPS──► Nginx ──► crm-api (Fastify)  ◄── LISTEN/NOTIFY ──┐   │
 (React SPA)  ◄─SSE──┘             │  REST /api/*                       │   │
                                   │  Webhooks /webhooks/*              │   │
 Meta (WhatsApp,                   ▼                                    │   │
 Lead Ads) ──webhooks──►  PostgreSQL 16  ◄─────── crm-worker ───────────┘   │
 Landing pages ──API──►   (dados + fila de jobs)   (jobs, automações,       │
 Ferramentas ──webhook►                             agendador, mídia)       │
                                   │                                         │
                          /var/lib/crm/storage (mídias)   /var/backups/crm   │
                 └───────────────────────────────────────────────────────────┘
```

- **crm-api**: HTTP (REST), autenticação, permissões, webhooks públicos, SSE e arquivos do frontend.
- **crm-worker**: consome a fila de jobs (processamento de webhooks, download de mídia, re-tentativas de envio,
  automações, webhooks de saída, sincronização de investimento) e roda o agendador (lembretes, automações por tempo, manutenção).
- **PostgreSQL**: única dependência de infraestrutura. Também é a fila (`FOR UPDATE SKIP LOCKED`) e o barramento de eventos (`LISTEN/NOTIFY`).
  Isso elimina Redis e simplifica a hospedagem.

Em servidores pequenos é possível rodar tudo num processo só (`RUN_WORKER_IN_PROCESS=true`).

## Princípios

1. **Integrações desacopladas.** Nenhuma tela depende de serviço externo. Webhooks são gravados antes de processar; envios que falham
   por instabilidade são re-tentados; uma integração fora do ar só gera logs e alertas — o CRM continua operando.
2. **Confiabilidade de webhooks.** Validação de assinatura (HMAC SHA-256 com App Secret) → persistência em `webhook_events` com chave de
   deduplicação (hash do corpo) → resposta 200 imediata → processamento assíncrono com novas tentativas e backoff exponencial →
   reprocessamento manual pela tela de Integrações → reenfileiramento automático de eventos presos.
   Cada mensagem tem `wamid` único (índice único), então reentregas nunca duplicam.
3. **Eventos de domínio transacionais.** Mudanças relevantes (lead criado, etapa alterada, venda) geram um job `domain.event` **na mesma
   transação** da alteração — automações e webhooks de saída nunca se perdem nem disparam para alterações desfeitas.
4. **Permissões no servidor.** Toda consulta aplica o escopo do usuário (`leadScope`, `conversationScope`, `ownerScope`).
   O frontend apenas reflete o que a API permite.
5. **Tempo real sem vazamento.** SSE envia somente “sinais” (tipo + id). Os dados são sempre buscados pela API, que aplica as permissões.
6. **Fuso horário.** Datas em `timestamptz` (UTC); agregações e filtros convertem para `America/Sao_Paulo`; o frontend formata no mesmo fuso.

## Perfis e permissões

| Recurso | Administrador | Gestor comercial | Vendedor |
|---|---|---|---|
| Leads / conversas / oportunidades | todos | da sua equipe + sem responsável (todos se não tiver equipe) | próprios (e conversas atribuídas); opcionalmente sem responsável |
| Trocar responsável, distribuir, excluir, mesclar, importar, exportar | ✔ | ✔ | — (pode assumir conversa sem responsável e transferir as suas) |
| Relatórios | geral | da equipe | próprios números |
| Catálogo, funis, etiquetas, motivos de perda, campanhas, automações, distribuição | ✔ | ✔ | leitura |
| Usuários, equipes, campos personalizados, integrações (credenciais), configurações gerais, auditoria | ✔ | leitura parcial / testes | — |

## Modelo de dados (principais tabelas)

| Tabela | Conteúdo |
|---|---|
| `users`, `teams`, `sessions`, `password_resets` | usuários, perfis, equipes, sessões revogáveis (token com hash) |
| `leads` | cadastro único (telefone E.164, e-mail normalizado), origem, UTM, campanha, curso, responsável, status, campos personalizados (`jsonb`), marcos (primeiro contato, última interação), consentimento |
| `lead_events` | linha do tempo de tudo que acontece com o lead |
| `lead_status_history` | histórico de status comercial |
| `lead_tags`, `tags`, `custom_fields` | etiquetas e definição dos campos personalizados |
| `pipelines`, `pipeline_stages` | funis e etapas (aberta/ganho/perda, probabilidade, limite de dias parado) |
| `opportunities`, `opportunity_stage_history` | oportunidades (N por lead), valores previsto e vendido, ganho/perda, movimentações com tempo na etapa |
| `tasks` | agenda (tipos, responsável, vencimento, lembrete, resultado, reagendamentos) |
| `courses`, `course_categories`, `course_materials` | catálogo |
| `campaigns`, `campaign_spend` | campanhas (por utm_campaign ou ID externo) e investimento diário (manual ou Meta Ads) |
| `wa_accounts`, `wa_templates` | números da Cloud API (token criptografado) e modelos sincronizados |
| `conversations`, `conversation_sessions`, `messages`, `conversation_tags`, `quick_replies` | atendimento, sessões (métricas), mensagens com status e mídia |
| `integrations`, `api_keys`, `integration_logs`, `webhook_events`, `outbound_deliveries`, `idempotency_keys` | integrações, credenciais criptografadas, logs, eventos recebidos, entregas |
| `automation_rules`, `automation_runs` | regras e histórico de execuções (com deduplicação por episódio) |
| `jobs` | fila persistente |
| `notifications`, `audit_logs`, `settings` | notificações internas, auditoria, configurações |

Migrations em `server/src/db/migrations/*.sql`, aplicadas em ordem, em transação e com trava consultiva (seguras com vários processos).

## Fluxo de entrada de lead

1. Canal (formulário/API, Lead Ads, webhook, WhatsApp, importação) chama `intakeLead`.
2. Normalização (telefone E.164 com variantes do 9º dígito, e-mail minúsculo) e trava por contato (evita corrida de envios simultâneos).
3. Deduplicação: se existe, completa dados faltantes, registra “reentrada” e notifica o responsável; senão cria.
4. Campanha resolvida por `utm_campaign` (criada automaticamente) ou ID externo do anúncio.
5. Distribuição: rodízio ou menor carga entre usuários ativos marcados para receber leads, respeitando limite de leads abertos.
6. Oportunidade no funil padrão (valor = preço vigente do curso) se não houver uma aberta para o mesmo curso.
7. Tarefa de primeiro contato para o responsável + notificação interna em tempo real.
8. Evento `lead.created` → automações e webhooks de saída.

## Métricas — definições

- **Conversão de leads**: leads criados no período que possuem oportunidade ganha (coorte), ÷ leads criados no período.
- **Faturamento / vendas**: soma de `sale_value` e quantidade de oportunidades ganhas no período (data do ganho).
- **Ticket médio**: faturamento ÷ vendas.
- **Tempo de primeira resposta (WhatsApp)**: para cada mensagem do cliente que inicia uma espera, tempo até a próxima mensagem da empresa.
- **Tempo até o 1º contato**: `first_contact_at − created_at` do lead (mensagem enviada, contato registrado ou tarefa de contato concluída).
- **CPL / CPA / ROAS**: somente para campanhas com investimento registrado; nunca estimados.
