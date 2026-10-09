#!/usr/bin/env bash
# Backup do banco (pg_dump formato custom) + arquivos de mídia, com retenção.
# Uso: deploy/backup.sh   (variáveis opcionais: BACKUP_DIR, RETENTION_DAYS, RCLONE_REMOTE)
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/crm}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
set -a; source "$APP_DIR/server/.env"; set +a
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$BACKUP_DIR/crm-db-$STAMP.dump"
if [[ -d "${STORAGE_DIR:-/var/lib/crm/storage}" ]]; then
  tar -czf "$BACKUP_DIR/crm-media-$STAMP.tar.gz" -C "${STORAGE_DIR:-/var/lib/crm/storage}" .
fi
# verificação básica do dump
pg_restore --list "$BACKUP_DIR/crm-db-$STAMP.dump" > /dev/null

find "$BACKUP_DIR" -name 'crm-*' -mtime +"$RETENTION_DAYS" -delete
# cópia externa opcional (ex.: Google Drive, S3, Backblaze) via rclone
if [[ -n "${RCLONE_REMOTE:-}" ]] && command -v rclone >/dev/null; then
  rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --include "crm-*-$STAMP*"
fi
echo "$(date -Is) backup ok: $STAMP"
