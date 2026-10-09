# CRM Comercial Micro Fácil

CRM comercial completo para a operação de vendas de cursos, formações e programas da Micro Fácil:
captação de leads, atendimento pelo WhatsApp (API oficial da Meta), funil de vendas, agenda de follow-ups,
catálogo de cursos, automações, relatórios e administração com controle de permissões.

> Sistema real, sem dados simulados: todos os indicadores são calculados a partir do que é registrado no banco.

## Módulos

| Módulo | O que faz |
|---|---|
| **Central** | Indicadores do período com comparativo (leads, vendas, faturamento, ticket, conversão), estado atual (em atendimento, aguardando resposta, sem responsável, sem contato, parados), origens, desempenho por vendedor, pendências e alertas. Filtros por período, vendedor, curso e campanha. |
| **Conversas** | Central de atendimento estilo WhatsApp Web sobre a Cloud API oficial: tempo real, mídia, notas internas, respostas rápidas (`/atalho`), modelos aprovados, janela de 24h, status de entrega/leitura, atribuição/transferência, etiquetas, encerramento/reabertura, painel do lead com etapa do funil e agendamento. Suporte a coexistência (app WhatsApp Business no celular + API). |
| **Leads** | Cadastro manual, entrada automática por integrações, importação/exportação CSV/Excel, campos personalizados, etiquetas, deduplicação (telefone com/sem 9º dígito e e-mail), mesclagem, distribuição automática (rodízio ou menor carga), busca e filtros combinados persistentes, ações em lote, perfil único com linha do tempo completa, histórico de status e LGPD (anonimização). |
| **Funil** | Kanban com arrastar e soltar (mouse e toque), múltiplos funis e etapas editáveis, valor previsto, curso, previsão de fechamento, motivo de perda, histórico de movimentações, tempo na etapa, oportunidades paradas, totais e valor ponderado por etapa. Um lead pode ter várias oportunidades. |
| **Agenda** | Pendências, dia, semana e mês; ligações, mensagens, reuniões, visitas, tarefas e lembretes; atribuição pela gestão; lembretes e alertas de vencimento; conclusão com resultado e agendamento do próximo retorno; reagendamento com histórico. |
| **Catálogo** | Cursos, formações e programas com categoria, modalidade, carga horária, preço/promocional com validade, condições comerciais, orientações aos vendedores, materiais de apoio e indicadores por produto (interessados, vendas, receita). |
| **Automações** | Gatilhos por evento ou por tempo, condições, ações encadeadas, atraso, ativação/desativação, histórico de execuções e tratamento de falhas. Envio de modelos de WhatsApp apenas com consentimento e sem disparo em massa. |
| **Relatórios** | Captação, atendimento (tempo de primeira resposta, produtividade), vendas, funil (conversão entre etapas, tempo médio) e marketing (UTM, campanhas, CPL/CPA/ROAS quando há investimento real). Exportação CSV e Excel. |
| **Integrações** | WhatsApp Cloud API (manual ou Embedded Signup), Meta Lead Ads, Meta Ads Insights, API de captação para landing pages, webhooks de entrada (com mapeamento) e de saída (assinados). Status, testes de conectividade, logs, eventos recebidos com reprocessamento e fila de jobs. |
| **Administração** | Usuários e perfis (Administrador, Gestor comercial, Vendedor), equipes, distribuição, funis, campos personalizados, etiquetas, motivos de perda, respostas rápidas, campanhas e investimento, configurações gerais e auditoria. |

## Tecnologia

- **Backend:** Node.js 22 + TypeScript + Fastify, PostgreSQL 16, validação com Zod, migrations SQL versionadas.
- **Frontend:** React 18 + Vite + TanStack Query, interface responsiva (desktop, tablet e celular).
- **Tempo real:** Server-Sent Events + `LISTEN/NOTIFY` do PostgreSQL.
- **Processamento assíncrono:** fila de jobs persistente no próprio PostgreSQL (sem Redis), com novas tentativas e recuperação.
- **Hospedagem alvo:** VPS Hostinger (Ubuntu) com Nginx + PM2 + Let's Encrypt.

## Desenvolvimento local

Pré-requisitos: Node.js 22+ e PostgreSQL 14+.

```bash
npm install
cp server/.env.example server/.env    # ajuste DATABASE_URL e gere APP_ENCRYPTION_KEY (openssl rand -hex 32)
#   para desenvolvimento use NODE_ENV=development, COOKIE_SECURE=false e RUN_WORKER_IN_PROCESS=true
npm run setup                          # migrations + configuração padrão + primeiro administrador
npm run dev                            # API em :3000 e interface em :5173 (proxy para a API)
```

Testes automatizados (usam um banco separado, recriado a cada execução):

```bash
createdb crm_test   # ou via psql
TEST_DATABASE_URL=postgres://usuario:senha@127.0.0.1:5432/crm_test npm test
```

## Produção

Guia completo: **[docs/IMPLANTACAO_HOSTINGER.md](docs/IMPLANTACAO_HOSTINGER.md)**. Resumo:

```bash
git clone <repo> /opt/crm && cd /opt/crm
sudo bash deploy/install.sh crm.seudominio.com.br voce@seudominio.com.br
```

## Documentação

- [Arquitetura e modelo de dados](docs/ARQUITETURA.md)
- [Implantação na Hostinger](docs/IMPLANTACAO_HOSTINGER.md)
- [Integrações (WhatsApp, coexistência, Lead Ads, Ads Insights, API, webhooks) e o que falta para ativar](docs/INTEGRACOES.md)
- [Segurança e LGPD](docs/SEGURANCA_LGPD.md)
- [Guia de uso por perfil](docs/GUIA_DE_USO.md)

## Estrutura

```
server/            API, serviços de domínio, fila de jobs, migrations e testes
  src/db/          pool, migrations SQL, configuração padrão
  src/lib/         autenticação/permissões, criptografia, fila, tempo real, auditoria
  src/services/    leads, funil, agenda, conversas, WhatsApp, Meta, automações, webhooks
  src/routes/      rotas HTTP por módulo
  test/            testes de fluxo (Vitest + PostgreSQL + Graph API simulada nos testes)
web/               interface React
deploy/            instalação, Nginx, backup, restauração e atualização
docs/              documentação
```
