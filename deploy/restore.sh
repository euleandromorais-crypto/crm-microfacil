#!/usr/bin/env bash
# Restauração: deploy/restore.sh /var/backups/crm/crm-db-AAAAMMDD-HHMMSS.dump [crm-media-...tar.gz]
# ATENÇÃO: substitui os dados atuais. Pare os processos antes: pm2 stop crm-api crm-worker
set -euo pipefail
DUMP="${1:?Informe o arquivo .dump}"
MEDIA="${2:-}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$APP_DIR/server/.env"; set +a
read -r -p "Isto vai SUBSTITUIR o banco atual. Digite RESTAURAR para continuar: " ok
[[ "$ok" == "RESTAURAR" ]] || { echo "Cancelado"; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP"
if [[ -n "$MEDIA" ]]; then
  mkdir -p "${STORAGE_DIR:-/var/lib/crm/storage}"
  tar -xzf "$MEDIA" -C "${STORAGE_DIR:-/var/lib/crm/storage}"
fi
echo "Restaurado. Inicie novamente: pm2 start crm-api crm-worker"
