#!/usr/bin/env bash
# Atualização sem perda de dados: backup -> código -> build -> migrations -> reload
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
"$APP_DIR/deploy/backup.sh"
git pull --ff-only
npm ci
npm run build
(cd server && npm run migrate:prod)
pm2 reload ecosystem.config.cjs --update-env
echo "Atualizado para $(git rev-parse --short HEAD)"
