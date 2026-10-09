#!/usr/bin/env bash
# Instalação do CRM em VPS Hostinger (Ubuntu 22.04/24.04), executar como root:
#   curl/clone o repositório em /opt/crm e rode: sudo bash deploy/install.sh crm.seudominio.com.br email@seudominio.com.br
set -euo pipefail

DOMAIN="${1:?Informe o domínio. Ex.: bash deploy/install.sh crm.empresa.com.br admin@empresa.com.br}"
EMAIL="${2:?Informe o e-mail para o certificado SSL}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="crm"

echo ">> Atualizando pacotes"
apt-get update -y && apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg git nginx ufw postgresql postgresql-contrib certbot python3-certbot-nginx

echo ">> Node.js 22 LTS"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2

echo ">> Usuário de sistema"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p /var/lib/crm/storage /var/backups/crm
chown -R "$APP_USER":"$APP_USER" /var/lib/crm /var/backups/crm "$APP_DIR"

echo ">> Banco de dados PostgreSQL"
DB_PASS="$(openssl rand -hex 16)"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='crm'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE USER crm WITH PASSWORD '${DB_PASS}';"
  sudo -u postgres psql -c "CREATE DATABASE crm OWNER crm;"
  sudo -u postgres psql -d crm -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
  NEW_DB=1
else
  NEW_DB=0
  echo "   usuário 'crm' já existe — mantendo a senha atual do .env"
fi

echo ">> Arquivo de configuração"
ENV_FILE="$APP_DIR/server/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$APP_DIR/server/.env.example" "$ENV_FILE"
  sed -i "s|^APP_URL=.*|APP_URL=https://${DOMAIN}|" "$ENV_FILE"
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://crm:${DB_PASS}@127.0.0.1:5432/crm|" "$ENV_FILE"
  sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$(openssl rand -hex 32)|" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  echo "   .env criado. FAÇA BACKUP da APP_ENCRYPTION_KEY em local seguro."
elif [[ "$NEW_DB" == "1" ]]; then
  echo "   ATENÇÃO: banco criado com nova senha (${DB_PASS}); ajuste DATABASE_URL no .env existente."
fi

echo ">> Dependências e build"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm ci && npm run build"

echo ">> Migrations e administrador inicial"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/server' && node dist/cli/setup.js" < /dev/tty

echo ">> PM2 (API + worker) com inicialização automática"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pm2 start ecosystem.config.cjs && pm2 save"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash || true
sudo -u "$APP_USER" pm2 install pm2-logrotate >/dev/null 2>&1 || true

echo ">> Nginx + HTTPS"
sed "s/crm.seudominio.com.br/${DOMAIN}/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/crm
# primeira emissão do certificado usa configuração HTTP simples
cat > /etc/nginx/sites-enabled/crm <<NGX
server { listen 80; server_name ${DOMAIN}; location / { proxy_pass http://127.0.0.1:3000; } }
NGX
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot certonly --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive
ln -sf /etc/nginx/sites-available/crm /etc/nginx/sites-enabled/crm
nginx -t && systemctl reload nginx

echo ">> Firewall"
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable

echo ">> Backup diário (03:15)"
chmod +x "$APP_DIR/deploy/"*.sh
cat > /etc/cron.d/crm-backup <<CRON
15 3 * * * $APP_USER $APP_DIR/deploy/backup.sh >> /var/log/crm-backup.log 2>&1
CRON
touch /var/log/crm-backup.log && chown "$APP_USER" /var/log/crm-backup.log

echo
echo "Instalação concluída: https://${DOMAIN}"
echo "Próximos passos: configure as integrações em Integrações (veja docs/INTEGRACOES.md)."
