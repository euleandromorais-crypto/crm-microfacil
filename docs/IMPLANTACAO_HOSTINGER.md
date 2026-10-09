# Implantação na Hostinger

## Qual plano usar

Use um **VPS Hostinger (KVM)** com Ubuntu 22.04 ou 24.04. Recomendado: **KVM 2** (2 vCPU, 8 GB RAM) para começar; KVM 1 funciona
para equipes pequenas.

Por que VPS e não hospedagem compartilhada/“Node.js Web App”: o CRM precisa de **processos permanentes** (recebimento de webhooks,
fila de processamento, agendador de lembretes e conexões em tempo real), de **PostgreSQL** e de armazenamento de mídias. Esses recursos
não são garantidos em planos compartilhados.

## 1. Preparar o domínio

No painel de DNS do domínio, crie um registro **A** `crm` apontando para o IP do VPS (ex.: `crm.microfacil.com.br`).

## 2. Instalação automática

Acesse o VPS por SSH (usuário root) e execute:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/euleandromorais-crypto/crm-microfacil.git /opt/crm
cd /opt/crm
bash deploy/install.sh crm.microfacil.com.br seu-email@microfacil.com.br
```

O script instala Node.js 22, PostgreSQL, Nginx, Certbot e PM2; cria o banco com senha aleatória, o arquivo `server/.env`
(com `APP_ENCRYPTION_KEY` aleatória), compila o sistema, aplica as migrations, pergunta os dados do **primeiro administrador**,
inicia os processos `crm-api` e `crm-worker`, configura HTTPS, firewall e o **backup diário**.

> Guarde em local seguro uma cópia do `server/.env` (principalmente `APP_ENCRYPTION_KEY`). Sem essa chave as credenciais de
> integração salvas no banco não podem ser lidas após uma restauração.

## 3. Configurações opcionais no `.env`

- **E-mail (recuperação de senha):** `SMTP_*` — com o e-mail da Hostinger: `smtp.hostinger.com`, porta `465`, `SMTP_SECURE=true`.
  Sem SMTP, o administrador gera links de redefinição em Administração › Usuários.
- Após editar: `pm2 reload ecosystem.config.cjs --update-env`.

## 4. Primeiros passos no sistema

1. Administração › Usuários: cadastre gestores e vendedores; marque “Recebe leads”.
2. Administração › Distribuição: escolha rodízio ou menor carga.
3. Catálogo: cadastre cursos com **código** (usado pelos formulários).
4. Administração › Funis: revise as etapas.
5. Integrações: conecte WhatsApp, Lead Ads e crie as chaves de API das landing pages (veja `docs/INTEGRACOES.md`).

## Operação

| Tarefa | Comando |
|---|---|
| Status dos processos | `sudo -u crm pm2 status` |
| Logs em tempo real | `sudo -u crm pm2 logs` (rotação automática com pm2-logrotate) |
| Reiniciar | `sudo -u crm pm2 reload all` |
| Atualizar versão | `sudo -u crm bash /opt/crm/deploy/update.sh` (faz backup, atualiza, migra e recarrega sem derrubar) |
| Backup manual | `sudo -u crm bash /opt/crm/deploy/backup.sh` |
| Restaurar | `sudo -u crm pm2 stop all && sudo -u crm bash /opt/crm/deploy/restore.sh /var/backups/crm/crm-db-....dump /var/backups/crm/crm-media-....tar.gz` |
| Saúde | `curl https://crm.seudominio.com.br/api/health` |

## Backups

- Diário às 03:15 (cron `/etc/cron.d/crm-backup`): `pg_dump` do banco + `tar.gz` das mídias em `/var/backups/crm`, retenção de 14 dias
  (`RETENTION_DAYS`). O dump é verificado com `pg_restore --list`.
- **Cópia externa (recomendado):** configure o [rclone](https://rclone.org) (Google Drive, S3, Backblaze…) e defina
  `RCLONE_REMOTE=meuremoto:crm-backups` no cron. Ative também os snapshots semanais do painel do VPS Hostinger.
- Teste uma restauração periodicamente em outro servidor.

## Monitoramento

- Configure um monitor externo (ex.: UptimeRobot) para `/api/health`.
- A tela Integrações mostra eventos de webhook com falha, jobs com falha/atrasados e erros das últimas 24h.

## Solução de problemas

| Sintoma | Verificar |
|---|---|
| Mensagens do WhatsApp não chegam | Integrações › Logs; App Secret correto; campos assinados no painel da Meta; URL de callback acessível por HTTPS |
| Tempo real não atualiza | Bloco `location /api/events` do Nginx (sem buffer) |
| Erro 502 | `pm2 status` / `pm2 logs crm-api` |
| Lembretes/automações parados | `pm2 logs crm-worker`; Integrações › Logs › Jobs com falha |
