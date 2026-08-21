#!/bin/sh
# houndfe-backend entrypoint — aplica migraciones de Prisma y arranca la app.
# Las migraciones corren en cada inicio (idempotente por diseño de `migrate deploy`).
set -e

echo "[entrypoint] Aplicando migraciones de Prisma..."
npx prisma migrate deploy

echo "[entrypoint] Iniciando houndfe-backend..."
exec "$@"
