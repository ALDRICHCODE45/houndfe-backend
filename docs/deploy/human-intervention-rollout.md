# Plan de despliegue a producción: intervención humana en el sistema (unidades 1-10)

Plan para llevar `feat/human-intervention` (HEAD `eddf63d8`) a producción. Nada de esto se ejecutó contra producción ni contra el dev `:3003`; cada paso lo corre el dueño y el día lo elige el dueño (spec `odd/tasks/human-intervention.md`, S5 y S14). Mismo estilo y mismas reglas que [production-launch-checklist.md](production-launch-checklist.md): el contenedor corre `npx prisma migrate deploy` al arrancar (`docker-entrypoint.sh`) y la app no responde hasta que termina.

## Checklist del dueño

- [ ] 1. Confirmar que producción ya tiene aplicadas las migraciones de `origin/main` (sección 3.1). Si falta alguna anterior a `20261110000000`, seguí primero el checklist de lanzamiento.
- [ ] 2. Mirar en Dokploy si hay **deploy automático al hacer push** a `main`. Si lo hay, hacé los pasos 3-6 **antes** del push.
- [ ] 3. Backup de la base de producción, verificado con `pg_restore -l` (sección 4.1).
- [ ] 4. Corrida local sobre `main` ya fusionado: `pnpm build`, `pnpm test`, `pnpm test:integration` verdes (los flakes conocidos, en 2.3) y `/tmp/houndfe-restock-tests.sh` 11/11 (sección 2).
- [ ] 5. Confirmar que `DATABASE_URL` de producción es una conexión directa a PostgreSQL (sin pgbouncer en modo transacción) y que `max_connections` aguanta una conexión más por réplica (4.5).
- [ ] 6. Confirmar que la llave de Spaces puede **listar** el bucket (4.6).
- [ ] 7. Elegir una hora de poco tráfico: la app está caída mientras corren las 15 migraciones (sección 3.3).
- [ ] 8. `git push origin main` y mirar los logs del contenedor hasta ver `Iniciando houndfe-backend...` (sección 5, paso 2).
- [ ] 9. Humo del backend con el token del bot y con un JWT de staff (5.3). Esperados exactos en la tabla.
- [ ] 10. Dar los permisos nuevos a Manager y Cashier: dry-run y luego `--apply` (4.3).
- [ ] 11. Reporte de teléfonos duplicados y backfill: dry-run, decidir qué hacer con los pendientes viejos, `--apply`, `--check` (4.4).
- [ ] 12. Agregar los 7 scopes nuevos a la credencial del bot (4.2) y **resincronizar Inngest Cloud** (4.7).
- [ ] 13. Solo entonces: deploy del chatbot, con los handlers de las unidades 5-10 ya fusionados (sección 5.5).
- [ ] 14. Prueba del SSE en producción con `curl` (sección 1.3). Hasta que pase, el frontend sigue con polling.
- [ ] 15. Post-checks (sección 6) y tener claro el rollback (sección 7).

## 1. Alcance

### 1.1 Qué se despliega

Rama `feat/human-intervention`: 62 commits sobre `main` (`git rev-list --count main..feat/human-intervention`), 15 migraciones, 284 archivos en `src/`. No cambian `package.json`, `pnpm-lock.yaml`, `Dockerfile` ni `docker-entrypoint.sh` (`git diff --name-only origin/main...HEAD` sobre esos archivos no los lista).

| Pieza | Qué es | Dónde |
| --- | --- | --- |
| Unidades 1-3 | Permisos nuevos, `ActiveUserGuard`, solicitudes comunes (`ChatbotRequest`) con CAS, envoltura de RESTOCK/EXPIRATION/DELIVERY_ZONE/comprobantes | `src/chatbot-requests`, `src/auth`, `docs/chatbot-requests-model.md` |
| Unidad 4 (+ T6b, T6c) | API del staff: grupos, listas, conteos, historial, detalle, auditoría, fusionar, ligar cliente, `allowedActions`, `slaLevel` | `src/chatbot-requests/presentation/chatbot-request-*.controller.ts` |
| Unidad 5 | Contrato del bot: crear, cancelar, feed (long-poll), ACK, recuperación | `src/chatbot-requests/presentation/bot-*.controller.ts` |
| Unidad 6 (+ T6d) | Notificaciones (bandeja, preferencias, correo por Inngest) | `src/notifications` |
| Unidad 7 (T7a-T7g) | Ajustes de atención (`/chatbot-settings`), reloj de horario, barrido de SLA, retención | `src/chatbot-settings`, `src/chatbot-requests/infrastructure/chatbot-sla-sweep.scheduler.ts` |
| Unidad 8 | Tiempo real: log `realtime_events`, `GET /realtime/stream` | `src/realtime`, `docs/frontend-handoff/17-realtime-sse.md` |
| Unidad 9 | Espejo de conversaciones, subida de medios a Spaces, lectura del staff, purga a 12 meses | `src/conversations` |
| Unidad 10 | Respuesta del staff a aclaraciones (`POST /chatbot-requests/:id/reply`) | `docs/frontend-handoff/19-clarification-replies.md` |

Cambios de comportamiento sobre lo que ya existe (todos cubiertos por specs en la rama): las rutas viejas de decisiones humanas ahora también cierran la solicitud envuelta; resolver por la ruta común exige además el permiso de siempre (spec L14); las rutas de decisiones del bot tienen su propio contador de límite (`docs/chatbot-handoff/chatbot-requests-bot-contract.md`, «Route budgets»); el límite de las rutas del bot ahora vive en la base (`service_rate_buckets`).

### 1.2 Qué NO se despliega

- **Unidad 11** (conversación en vivo, sesiones, plantilla al iniciar): vive en `../houndfe-backend-u11`, rama `feat/human-intervention-u11`. Hoy esa rama apunta al mismo `eddf63d8` (sin commits propios). Sale después, desde su worktree.
- Unidades 12-14. `scheduledFor` responde `422 SCHEDULING_DISABLED` hasta la unidad 14 (spec L25).
- Diferido a la unidad 11: plantilla de WhatsApp y corrección de `lastCustomerMessageAt` en respuestas diferidas (L123); el espejo todavía no mueve la ventana de 24 h (`docs/chatbot-handoff/chatbot-requests-bot-contract.md`, «Not covered by unit 9»).
- **SSE para el frontend:** el código y la ruta `GET /realtime/stream` sí se despliegan (y el trigger que escribe `realtime_events` corre desde la migración), pero el frontend sigue con polling hasta que el dueño pruebe Traefik/Swarm (`docs/frontend-handoff/17-realtime-sse.md`, línea 7; propuesta §15).

### 1.3 Prueba del SSE en producción (R6)

Criterio del contrato: un evento llega en menos de 1 s y la conexión sobrevive 30 min detrás de Traefik. Con un JWT de staff que tenga `read:ChatbotRequest` (no lo pegues en chats ni lo dejes en el historial):

```sh
read -rs TOKEN
curl -N -sS -D /tmp/sse-headers.txt --max-time 1000 \
  -H "Authorization: Bearer $TOKEN" https://api.houndfe.com/realtime/stream \
  | while IFS= read -r l; do printf '%s %s\n' "$(date +%T.%3N)" "$l"; done | tee /tmp/sse-prod.log
cat /tmp/sse-headers.txt
```

Qué mirar:

1. Cabeceras: `200`, `content-type: text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no`, **sin** `content-length` y sin `content-encoding: gzip/br` (el backend manda `identity`; `src/realtime/presentation/realtime.controller.ts`).
2. `retry: 3000` y `event: ready` aparecen en el primer segundo. Si todo llega junto después de varios segundos, Traefik está guardando el cuerpo en búfer.
3. `event: heartbeat` cada 15 s (±1) con la hora local de cada línea. Un hueco de 45 s o más es el criterio del frontend para darla por muerta.
4. Desde otra sesión (UI, un claim/release de una solicitud de prueba) el `event: request.*` aparece en menos de 1 s.
5. El token dura 15 min por defecto (`JWT_ACCESS_EXPIRATION`, `src/shared/config/env.validation.ts:57`): el stream termina limpio con `event: auth-expired` en el `exp` (handoff 17, sección 3). Para cubrir 30 min encadená dos conexiones con un token nuevo y `-H "Last-Event-ID: <último id>"`. Un corte **sin** `auth-expired` (curl sale con 18, 52 o 56) o un silencio de 45 s es el timeout o el búfer del proxy: dejá el polling y ajustá Traefik.
6. Otros resultados: `503 STREAM_CAPACITY` (1 000 streams) o `503 REALTIME_UNAVAILABLE` (el `LISTEN` no arrancó; ver 4.5).

## 2. Plan de merge (acciones del dueño)

`main` local está **10 commits por delante de `origin/main`** (`git log --oneline origin/main..main`). Hoy `origin/main` es `bd53a983`, `main` es `3930be05` y `main` es ancestro de la rama (`git merge-base main feat/human-intervention` = `3930be05`), así que el merge no tiene conflictos posibles. Esos 10 commits viajan con el push; tocan solo `docs/` y `scripts/` (más `eslint.config.mjs`), ninguno toca `src/` ni `prisma/`:

```text
3930be05 merge: human intervention contract v1
88b0740a merge: showcase catalog loader and products
a590ce9c docs(proposals): record the chatbot's reconciliation of contract v1
b2fe56af docs(proposals): record the chatbot's second-round answers in contract v1
b88c1a5f docs(proposals): close the human intervention proposal as contract v1
ba7d3e40 docs(proposals): record chatbot answers and reconcile the human intervention contract
1eb50f6f docs(proposals): add backend proposal for in-system human intervention
d410c1d4 feat(ops): add toy, hygiene, accessory and habitat showcase products with image credits
6f322405 feat(ops): add food, treat and care showcase products with image credits
49e53e65 feat(ops): add showcase catalog loader with editorial publish and SKU-scoped delete
```

### 2.1 Comandos

```sh
cd /home/aldrich_coder45/Desktop/workspace/houndfe/houndfe-backend
git status --short                      # tiene que salir vacío
git fetch origin && git rev-parse --short origin/main   # esperado: bd53a983 (si cambió, hay trabajo nuevo en GitHub)
git switch main
git merge --no-ff feat/human-intervention -m "merge: in-system human intervention (units 1-10)"
git diff --stat feat/human-intervention main            # vacío: el árbol es idéntico al de la rama
pnpm build
pnpm test
pnpm test:integration
bash /tmp/houndfe-restock-tests.sh      # 11 specs aisladas de human-decisions (ver 2.2)
# SOLO si el dueño ya terminó los pasos previos de la sección 4 (deploy automático, ver checklist 2):
git push origin main
```

Todo se corre por los scripts del proyecto (`pnpm test*`), no con el binario de Jest (`AGENTS.md`). Si ves `[run-tests] waiting`, está en cola: esperá.

### 2.2 Por qué hace falta el script aislado

Las 10 specs de `src/human-decisions` y la de checkout se niegan a correr sobre la base de pruebas compartida; el script `/tmp/houndfe-restock-tests.sh` usa una base aislada del contenedor de pruebas (spec L13-L16, L86). Su última corrida verde fue **antes** de las unidades 9 y 10 (L97: 11/11 suites, 220/220). Desde esa corrida no hubo commits en `src/human-decisions`, `src/delivery-zones`, `src/receipts` ni `src/sales` (`git log 875816a6..HEAD -- <esas carpetas>` sale vacío), así que el riesgo es bajo; aun así es la prueba de que las rutas viejas siguen intactas: repetila sobre el árbol final y que nada más use esa base mientras corre (L88 fue una colisión así).

### 2.3 Flakes conocidos (no son regresiones si pasan solos)

Si falla una spec de integración, corré **ese archivo solo** (`pnpm test:integration src/ruta/archivo.integration.spec.ts`). Si pasa sola y falla en la corrida completa, es de esta lista (spec L72, L75, L81, L98, L104, L123): `conversation-retention` «no retry storm», `notification-retention` «is index-backed» (el plan de EXPLAIN en tabla chica), `Prisma too many clients`, `chatbot-sla-sweep` idle tick < 50 ms, `chatbot-settings` «recompute works in bounded batches». Última referencia: 1296 unit y 616 integration en `cb0c37b1` (L123); después se sumaron specs, no esperes los mismos números.

Brecha reconocida: nunca se corrió el chequeo de deriva entre `prisma/schema.prisma` y las migraciones (L64: no hay base sombra sin `.env`). Si querés cerrarla: `pnpm prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <base vacía descartable>` y leé qué lista. Esperá diferencias de lo que Prisma no expresa (índices parciales, CHECKs, triggers, la columna generada `sales.openDebtCents`); cualquier otra cosa es un problema.

## 3. Migraciones

### 3.1 Antes de nada: ¿qué tiene producción?

El diff de la rama contra `origin/main` son exactamente 15 migraciones (`git diff --name-only origin/main...feat/human-intervention -- prisma/migrations`); la última de `origin/main` es `20261108090000_sales_open_debt_cents`. Eso supone que producción ya está en esa. **No está verificado**: el checklist de lanzamiento dice que nada se ejecutó contra producción. En la base de producción:

```sql
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 3;
SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL;   -- tiene que salir vacío
```

La primera tiene que mostrar `20261108090000_sales_open_debt_cents`. Si producción está más atrás, el deploy aplicaría también esas migraciones (incluida `20261104020000_inventory_journal_storage`, que escribe datos y falla con stock negativo): seguí antes [production-launch-checklist.md](production-launch-checklist.md) y [inventory-journal-o1-rollout.md](inventory-journal-o1-rollout.md).

### 3.2 Las 15 migraciones, en orden

Todas son aditivas y empiezan con `SET LOCAL lock_timeout = '5s'` (Prisma aplica cada archivo como una transacción: si vence, no queda nada aplicado). Ninguna tiene `GENERATED`, `CONCURRENTLY` ni toca columnas existentes salvo la 3. En producción **todas las tablas nuevas nacen vacías**, así que los `CREATE INDEX` (que toman lock `SHARE`: bloquean escrituras, no lecturas) y el cambio de CHECKs son de milisegundos; lo que puede esperar es el lock sobre las **tablas que ya existen**.

| # | Migración | Qué hace | Locks sobre tablas existentes | Datos |
| --- | --- | --- | --- | --- |
| 1 | `20261110000000_chatbot_requests` | 7 enums; tablas `chatbot_requests`, `chatbot_request_events`, `chatbot_customer_groups`, `chatbot_request_folio_counters`; ~20 índices; CHECKs; trigger de solo-agregar en eventos y trigger «guardar para siempre» en solicitudes | FKs: `SHARE ROW EXCLUSIVE` en `tenants`, `customers`, `human_decisions`, `delivery_zone_requests`, `receipt_evidences` hasta el commit (bloquea escrituras ahí; espera a transacciones abiertas) | No |
| 2 | `20261110010000_chatbot_request_staff_receipts` | `staff_command_receipts` (idempotencia del staff) | FK a `tenants`: `SHARE ROW EXCLUSIVE` | No |
| 3 | `20261110030000_chatbot_request_bot_intake` | `service_rate_buckets`, `chatbot_bot_receipts`; `ALTER TABLE service_credentials ADD COLUMN "rateLimits" JSONB` (nullable) | **`ACCESS EXCLUSIVE` breve sobre `service_credentials`** (la lee cada request del bot; espera a transacciones abiertas); `tenants` `SHARE ROW EXCLUSIVE` | No |
| 4 | `20261110050000_chatbot_feed` | `chatbot_feed_items`, `chatbot_feed_retention` | FK a `tenants` | No |
| 5 | `20261110060000_chatbot_feed_recovery` | Reemplaza 2 CHECKs de `chatbot_feed_items` (`DEFERRED_HUMAN_SESSION`), cambia 1 índice parcial y agrega 2 en `chatbot_requests` | Solo tablas de la propia rama (vacías en prod): `ACCESS EXCLUSIVE` + un escaneo de 0 filas; en dev sería ~200k filas de feed (decenas de ms) | No |
| 6 | `20261111000000_notifications` | `notifications`, `notification_preferences` | FKs a `tenants` y `users` | No |
| 7 | `20261111050000_chatbot_attention_settings` | `chatbot_attention_settings` y `chatbot_attention_settings_events` | FKs a `tenants` | No (sin fila = valores por defecto, versión 0) |
| 8 | `20261111060000_notification_retention` | Índice `notifications("createdAt")` (`IF NOT EXISTS`) | Ninguno (tabla nueva vacía) | No |
| 9 | `20261111070000_chatbot_sla_sweep` | 2 índices únicos parciales (aviso de vencida; hitos `SLA_MILESTONE`) | Ninguno (tablas nuevas) | No (construyen sobre 0 filas) |
| 10 | `20261112000000_realtime_events` | `realtime_events` (BIGSERIAL), `realtime_event_retention`; función y **trigger diferido** en `chatbot_request_events` | FKs a `tenants`; `SHARE ROW EXCLUSIVE` breve en `chatbot_request_events` (nueva) | No. Desde aquí cada evento de solicitud agrega 1 fila al commit y toma un advisory lock por sucursal (costo medido «bajo el ruido», L93) |
| 11 | `20261112020000_conversation_mirror` | `chatbot_conversations`, `conversation_messages`, `conversation_media`, 5 enums, triggers de inmutabilidad, índice parcial en `chatbot_requests` | FKs a `tenants` | No |
| 12 | `20261112030000_conversation_unread_media_intents` | 2 columnas en `chatbot_conversations`, `conversation_media_intents`, `conversation_media_orphan_sweep`, trigger de lápida, reemplaza 2 funciones | Tablas nuevas | **Sí, mínimo**: `UPDATE chatbot_conversations SET lastStaffReadSeq = nextSeq - 1` (0 filas en prod: el espejo es nuevo) e `INSERT` de 1 fila cursor |
| 13 | `20261112040000_chatbot_settings_closed_date_reasons` | Columna `closedDateReasons JSONB DEFAULT '{}'` + CHECK | `ACCESS EXCLUSIVE` breve sobre una tabla nueva y chica | No |
| 14 | `20261112050000_clarification_replies` | `CREATE OR REPLACE` de la función del trigger realtime + 2 índices únicos parciales | Ninguno | No |
| 15 | `20261112060000_chatbot_requests_counts_index` | Índice parcial `chatbot_requests_open_unassigned_idx` | Ninguno | No |

Fuente de cada fila: el comentario de cabecera del `migration.sql` correspondiente y `docs/chatbot-requests-model.md`, «Deploy safety». Los índices no se crean `CONCURRENTLY` porque no se puede dentro de la transacción de Prisma (cabecera de la 5).

### 3.3 Reglas del checklist de lanzamiento que aplican

- La app **no responde** mientras `migrate deploy` corre. Con estas migraciones son 15 transacciones cortas sobre tablas vacías; la espera real sería un lock en `tenants`/`service_credentials` (máximo 5 s por migración antes de abortar). No se midió en producción: tomalo como segundos, no como garantía.
- «Para tener siempre en mente»: ninguna de las 15 agrega columna generada ni reescribe tabla (se verificó con `grep GENERATED`: 0 coincidencias), así que la regla de `sales.openDebtCents` no se activa. Sí vale la advertencia contraria para el futuro: el índice sin `CONCURRENTLY` de la 12 sobre `conversation_messages` (cabecera de la migración: no copiarlo a una tabla grande).
- Prisma no maneja `sales.openDebtCents`: si alguna vez corrés `prisma migrate dev` y aparece un `ALTER COLUMN "openDebtCents" SET DEFAULT …`, borrá esa línea.

### 3.4 Si una migración vence por lock

1. Los logs muestran el error de `lock_timeout` y el contenedor sale (`set -e` en `docker-entrypoint.sh`). Esa migración no dejó nada; las anteriores del mismo arranque sí quedaron aplicadas.
2. Prisma queda en estado fallido (P3009) y no sigue hasta resolverlo. Confirmalo: `SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NULL;`.
3. Receta de las cabeceras: `npx prisma migrate resolve --rolled-back <nombre>` y volver a desplegar en un momento más tranquilo. Ejemplo: `prisma migrate resolve --rolled-back 20261110000000_chatbot_requests`.
4. Si el contenedor está en bucle de reinicio no hay `docker exec`: corré ese comando desde un contenedor efímero de la misma imagen y las mismas variables (terminal de Dokploy). Esto no está probado en este despliegue.
5. Si el bloqueo lo causa una transacción larga, buscala antes de reintentar: `SELECT pid, state, xact_start, left(query,80) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start;`.

## 4. Antes y justo después del deploy

### 4.1 Backup (obligatorio)

Es la única vuelta atrás completa para los datos. El checklist de lanzamiento no trae el comando; el patrón es el del script de dev del dueño (`/tmp/houndfe-dev-update.sh`, línea 15). Con el contenedor de Postgres de producción:

```sh
F=houndfe-prod-pre-human-intervention-$(date +%Y%m%d-%H%M%S).dump
docker exec <contenedor-postgres-prod> sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$F"
ls -lh "$F" && pg_restore -l "$F" | head      # tamaño > 0 y lista de objetos legible
```

Guardalo fuera del servidor.

### 4.2 Credencial del bot: 7 scopes nuevos

La credencial `chatbot-whatsapp` del checklist de lanzamiento (sección 3) tiene 12 scopes. Las rutas nuevas piden otros 7 (`src/chatbot-requests/domain/bot-scopes.ts`): `requests:create`, `requests:read`, `requests:cancel`, `feed:read`, `feed:ack`, `conversation:write`, `media:write`. Los scopes son texto libre y un scope faltante da `403 Insufficient service scope`. No hace falta token nuevo: el token y su `hashedKey` (sha256, ver L-entries de credenciales y el checklist de lanzamiento, pasos A/B) no cambian. En la base de producción:

```sql
SELECT "name","scopes","rateLimit","rateLimits","isActive" FROM "service_credentials" WHERE "name"='chatbot-whatsapp';
UPDATE "service_credentials"
SET "scopes" = ARRAY(SELECT DISTINCT unnest("scopes" || ARRAY['requests:create','requests:read','requests:cancel','feed:read','feed:ack','conversation:write','media:write']) ORDER BY 1)
WHERE "name"='chatbot-whatsapp' AND "isActive";     -- tiene que decir UPDATE 1
```

`rateLimits` queda en `NULL` y rigen los valores por defecto (write 300/min, read 300, feed 120; contrato del bot, «Route budgets»). El script `scripts/dev-showcase/rotate-bot-credential.cjs` se niega a correr en producción: no lo uses. Si algún día creás una credencial nueva, usá el INSERT del checklist con los 19 scopes.

### 4.3 Permisos para los roles existentes

Los permisos de roles solo vienen en el seed, no en las migraciones: en producción hay que darlos con el script. Necesita que el API **ya haya arrancado una vez** con esta versión (el `PermissionSeeder` crea las filas de `Permission` al arrancar; si faltan, el script se detiene con `PERMISSION_MISSING`). Va después del deploy. Reglas (L2, `scripts/ops/grant-chatbot-request-permissions.cjs`): Manager recibe todo menos `update:ChatbotSettingsAllBranches`; Cashier recibe `read:ChatbotRequest`, `update:ChatbotRequest`, `read:ChatbotConversation`; Super Admin ya tiene `manage:all`; los roles personalizados no se tocan y un tenant sin Manager o Cashier se informa, no se crea.

```sh
C=$(sudo docker ps -q -f name=houndfe-system-backend)
sudo docker exec "$C" mkdir -p /app/scripts/ops
sudo docker cp scripts/ops/grant-chatbot-request-permissions.cjs "$C":/app/scripts/ops/
sudo docker exec -w /app "$C" node scripts/ops/grant-chatbot-request-permissions.cjs           # dry-run: solo lee e imprime el plan
sudo docker exec -w /app "$C" node scripts/ops/grant-chatbot-request-permissions.cjs --apply   # upsert idempotente, sin borrados
```

Leé el dry-run antes del `--apply`: por tenant, qué se agrega y qué roles faltan. Quien deba usar «aplicar a todas las sucursales» necesita `update:ChatbotSettingsAllBranches` a mano (ni Manager ni Cashier lo reciben) y solo alcanza las sucursales donde tiene membresía (S7).

### 4.4 Teléfonos duplicados y backfill (después de que arranque el backend nuevo)

Los dos scripts cargan código compilado de la imagen nueva (`dist/chatbot-requests/...`), por eso **no pueden correr antes del deploy**; sí corren antes de usar o anunciar la bandeja. Misma mecánica de `docker cp` que en 4.3. Detalle y códigos de salida en `docs/chatbot-requests-backfill.md`.

1. **Teléfonos duplicados** (solo lectura, `scripts/ops/count-duplicate-customer-phones.cjs`): cuenta clientes que comparten teléfono canónico. Los números son un máximo (cota superior): esas solicitudes quedan sin ligar con `ambiguousCustomer` y el staff las liga a mano. No bloquea nada; sirve para saber cuánto trabajo manual viene.
   `sudo docker exec -w /app "$C" node scripts/ops/count-duplicate-customer-phones.cjs`
2. **Backfill dry-run:** `sudo docker exec -w /app "$C" node scripts/ops/backfill-chatbot-requests.cjs` (copiá antes el script con `docker cp`, y comprobá con el `ls` de `dist/.../chatbot-request-backfill.js` que la imagen es ≥ `b0ebd3a7`, como indica el runbook).
   Envuelve las decisiones pendientes de cualquier edad (fuente `houndfe-chatbot`), las zonas y los comprobantes pendientes, y lo resuelto en los últimos `RECENT_DAYS = 7` días (`scripts/ops/backfill-chatbot-requests.cjs:38`). Los comprobantes rechazados no se envuelven. Mirá por subtipo `oldestOpenAt` (edad en días del pendiente más viejo).
3. **Ráfaga de vencidas.** Las solicitudes envueltas nacen sin plazos y las primeras pasadas del barrido (cada 30 s) se los calculan; las que ya pasaron su plazo quedan vencidas de golpe. Reglas del contrato (`docs/chatbot-handoff/chatbot-requests-bot-contract.md`, «Deploy checklist for 7c»): el aviso al **cliente** (`request.overdue_notice`) solo sale si venció hace menos de 24 h; las de 24 h o más no producen ítem para el bot, pero el **staff** sí recibe un aviso por solicitud (retenido hasta la próxima apertura; correos agrupados en ventanas de 2 min, `docs/notifications-model.md`). El barrido drena hasta 1 000 filas por fase y tick de 30 s por réplica (`chatbot-sla-sweep.scheduler.ts:25-26`). Decisión del dueño según el dry-run: si hay muchos pendientes muertos de hace días, resolvelos o cancelalos en las pantallas viejas **antes** del `--apply` para que no inunden los avisos.
4. **Apply:** `… backfill-chatbot-requests.cjs --apply`, luego `--check` (esperado `OK: 0 mismatches`, salida 0) y una segunda corrida en seco que diga `0 request(s) to create`. Es seguro con la API viva. **Condición dura:** correrlo completo antes de que nadie resuelva por la ruta común de la bandeja (ventana de deadlock 40P01, sin corrupción; runbook, «When to run it»). El `--apply` no se puede deshacer (los envoltorios no se borran; ver «Roll back» del runbook), por eso se decide con el dry-run.

### 4.5 Variables de entorno y conexiones

`src/shared/config/env.validation.ts` **no cambia** en la rama: no hay variables obligatorias nuevas. Lo que cambia (solo nombres):

| Variable | Estado | Efecto |
| --- | --- | --- |
| `RECEIPTS_SPACES_BUCKET` / `SPACES_BUCKET` | existentes | Ahora también guardan los medios de conversación bajo `conversation-media/<tenantId>/` (`src/conversations/conversations.module.ts`). |
| `JWT_SECRET` | existente | Ahora también sella el `customerKey` opaco de la bandeja (`CustomerKeySealer`). Rotarlo invalida los `customerKey` que el frontend tenga guardados: se vuelven a pedir. |
| `NOTICE_NOTIFY_BATCH_SIZE` (25), `NOTICE_NOTIFY_MAX_RETRIES` (5), `NOTICE_EMAIL_BATCH_SIZE` (100), `NOTICE_EMAIL_LOCK_MS` (60000), `NOTICE_EMAIL_MAX_RETRIES` (5) | nuevas, opcionales, sin validación Joi | Afinan el consumidor y el despachador de avisos (`src/notifications/outbox/chatbot-request-notice-outbox.module.ts`). Dejalas sin definir. |
| `HOUNDFE_SCHEDULERS` | solo pruebas | Compuerta de los tests de integración; la app no la importa (`src/shared/scheduling/scheduler-gate.ts`). No la definas. |

Conexión a la base: `GET /chatbot-api/feed` y el SSE usan `LISTEN/NOTIFY` por una conexión `pg` propia con `DATABASE_URL` (`src/shared/realtime/pg-notification-listener.ts`). Necesita una conexión **directa** (sin pgbouncer en modo transacción) y cada réplica abre **una conexión extra** fuera del pool de Prisma (contrato del bot, «Deploy checklist for 5b»). Verificá `max_connections`. Si el `LISTEN` no arranca, el feed sigue respondiendo con espera corta y el SSE da `503 REALTIME_UNAVAILABLE`; el log dice `LISTEN connection lost; reconnecting`.

### 4.6 Spaces: permiso de listar

Los medios de conversación se suben privados y se purgan a los 12 meses. Además del escribir/borrar que ya usan los comprobantes, el barrido de huérfanos hace `ListObjectsV2` con prefijo `conversation-media/` (5 páginas de 1 000 por corrida, `src/conversations/infrastructure/spaces-conversation-media.lister.ts`). Si la llave de Spaces no puede listar, la subida y la lectura funcionan, pero el barrido falla en silencio: solo queda el log `conversation media orphan sweep failed` y los objetos huérfanos (PII) no se purgan. Confirmá el permiso de listado en la llave de producción.

### 4.7 Inngest

Resincronizá Inngest Cloud con `https://api.houndfe.com/api/inngest` después del deploy. Función nueva: `chatbot-request-notice-email` (evento `chatbot-request/email.requested`, concurrencia 5, 3 reintentos; `src/notifications/inngest/chatbot-request-email.functions.ts`). También cambió el correo de comprobantes (ya no lleva `customerName`; `src/receipts/inngest/receipt-review-notification.functions.ts`). Sin la resincronización los avisos por correo del staff fallan (en dev se vio `fetch failed` hasta 5 reintentos, L76); los avisos dentro del sistema funcionan igual.

### 4.8 Trabajos programados

Con la rama hay **16** `@Interval` (7 nuevos; `git grep '@Interval('` sobre `src/`), todos corren en cada réplica y tomar filas con `FOR UPDATE SKIP LOCKED`:

| Trabajo (nuevos) | Cadencia | Carga |
| --- | --- | --- |
| Barrido de SLA (`chatbot-sla-sweep.scheduler.ts`) | 30 s | Hasta 10 lotes × 100 por fase y tick; tick ocioso = 1 consulta por el índice parcial `chatbot_requests_sla_sweep_idx` |
| Consumidor de avisos (`chatbot-request-notify.consumer.ts`) | 1 s | Lotes de 25 de la tabla outbox |
| Despachador de correos (`chatbot-request-email.dispatcher.ts`) | 2 s | Lotes de 100 → eventos Inngest |
| Purga del feed del bot | tick 60 s, cada hora | 30 días, 1 000 × 20 lotes |
| Purga de notificaciones | tick 60 s, cada hora | 90 días |
| Purga de eventos realtime | tick 60 s, cada 10 min | 24 h |
| Retención de conversaciones | tick 60 s, cada hora | Mensajes y medios a 12 meses + barrido de huérfanos en Spaces |

Los 9 anteriores (outbox, zonas, rutas, horas libres, comprobantes, promociones ×3, stock) no cambian. Con una sola réplica la carga total es la de un poller de 1 s y uno de 2 s más consultas indexadas; en pruebas el feed ocioso hizo 0 consultas y no retiene conexión (`docs/perf/chatbot-feed-load-results.md`).

## 5. Orden del deploy

1. **Prerrequisitos:** secciones 2, 3.1 y 4.1 hechas; hora de poco tráfico. El bot viejo puede seguir corriendo: las rutas y el comportamiento que usa no cambian (specs diferenciales L25, L38, L60), pero verá errores mientras el contenedor migra. El **frontend** de producción tiene que tolerar campos nuevos en `GET /chatbot-settings` (`updatedBy`, `updatedAt`, `closedDateReasons`, `windowClosingSoon`): su pantalla de ajustes validaba en modo estricto y se rompía (L113); el FE lo adoptó en dev (L114, L120). Confirmá que esa versión está en producción.
2. **Backend.** `git push origin main` → Dokploy construye → el contenedor corre `prisma migrate deploy` (15 migraciones) y arranca. Mirá los logs: `[entrypoint] Aplicando migraciones…`, luego `[entrypoint] Iniciando houndfe-backend...`. Si falla una migración: 3.4. Verificá en la base: `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;` → `0`, y que las 15 aparezcan terminadas.
3. **Humo del backend.** Con `read -rs BOT_KEY` y `read -rs STAFF_JWT` (sin imprimirlos). Rutas exactas; ninguna crea datos:

| Request | Esperado |
| --- | --- |
| `GET /chatbot-api/feed?waitSeconds=0` sin token | `401` |
| mismo con `Authorization: Bearer $BOT_KEY` (con los scopes de 4.2) | `200` `{"items":[],"nextCursor":…}`; con la credencial vieja sin scopes: `403` |
| `GET /chatbot-api/requests?status=open` (bot) | `200` (recuperación; sin `status`: `400`) |
| `GET /chatbot-api/requests/pending-deliveries?conversationRef=wa:humo` (bot) | `200` `{"items":[]}` |
| `POST /chatbot-api/requests` con cuerpo `{}` y `X-Idempotency-Key: <uuid>` (bot) | `400` `VALIDATION_ERROR` |
| `POST /chatbot-api/conversations/wa:humo/messages:batch` con cuerpo `{}` (bot) | `400` (el literal `:batch` es parte de la ruta) |
| `POST /chatbot-api/messages/statuses:batch` con cuerpo `{}` (bot) | `400` |
| `GET /chatbot-requests/counts` (JWT de staff **con** los permisos del paso 4) | `200` con conteos en 0 (antes del backfill); sin permisos `403` |
| `GET /chatbot-requests/groups` y `GET /notifications/unread-count` (staff) | `200` |
| `GET /chatbot-settings` (Manager) | `200`: valores por defecto, lunes-sábado 9-19, `America/Mexico_City`, versión 0 |
| `GET /realtime/stream` (staff, `curl -N --max-time 5`) | `200` `text/event-stream` con `event: ready` (la prueba larga es la 1.3) |

   Las rutas del staff necesitan los permisos de 4.3: hacé el humo del bot primero y el del staff después del paso 4.
4. **Post-arranque** (secciones 4.3 y 4.4, en este orden): permisos (dry-run → `--apply`), duplicados, backfill (dry-run → decisión → `--apply` → `--check`). Después, scopes del bot (4.2) y resincronizar Inngest (4.7).
5. **Chatbot, recién ahora.** Debe tener fusionados los handlers de las unidades 5-10 y se despliega **después** del backend (S14). Según `docs/chatbot-handoff/chatbot-requests-bot-contract.md`:
   - **5b/5c** (líneas 336, 377): scopes `feed:read`, `feed:ack`, `requests:read`; consumidor del feed para `request.answered` (DECISION), `request.cancelled`, `request.merged`; ACK por `POST /chatbot-api/deliveries/:id/outcome` incl. `DEFERRED_WINDOW_CLOSED` y `DEFERRED_HUMAN_SESSION` (un backend viejo daría `400`); recuperación con `GET /chatbot-api/requests` tras `410 CURSOR_EXPIRED`.
   - **7c** (línea 372): handler de `request.overdue_notice`. Hasta que exista, el consumidor ACKea los tipos desconocidos `STALE` y es seguro reiniciar (L74).
   - **Unidad 9** (línea 512): `conversation:write` y `media:write`; subir el medio **antes** de espejar el mensaje; `messages:batch` y `statuses:batch`.
   - **Unidad 10** (línea 589): handler de `request.answered` con `kind: "CLARIFICATION"` y espejo con `staffReplyId`. Hasta que el handler exista, esos ítems se ACKean `STALE` y **el cliente no recibe la respuesta**.
   Evidencia E2E en dev contra el bot real: unidad 5 (L46), fusión (L66-L67), aviso de vencida (L77-L78), espejo y medios (L110-L116). **No hay evidencia registrada del handler de aclaraciones (unidad 10)** ni de su espejo: ver «Riesgos».
   El `SERVICE_KEY` del bot no cambia (los scopes se ampliaron en el servidor).

## 6. Post-deploy

Solo lectura, en la base de producción y en los logs:

```sql
SELECT status, count(*) FROM chatbot_requests GROUP BY status;                        -- tras el backfill: coincide con el dry-run
SELECT count(*) FROM chatbot_feed_items WHERE "ackedAt" IS NULL;                      -- debería vaciarse cuando el bot nuevo consuma
SELECT type, count(*) FROM chatbot_request_events WHERE type='SLA_MILESTONE' GROUP BY type;   -- crece por la ráfaga y se estabiliza
SELECT count(*) FROM realtime_events;                                                  -- crece con cada cambio; purga a las 24 h
```

- Logs sin `LISTEN connection lost` repetido, sin `conversation media orphan sweep failed` (4.6) y sin errores de correo (4.7).
- Primeros minutos: la ráfaga de avisos de 4.4 paso 3 se apaga sola; el conteo de `SLA_MILESTONE` deja de crecer.
- Staff: un Cashier y un Manager abren la bandeja; el Cashier no ve el teléfono completo (R12), el Manager sí con `read:CustomerPhone`.
- Con el bot nuevo: crear una solicitud de prueba por WhatsApp, verla en la bandeja, cancelarla con motivo y confirmar que el bot recibió `request.cancelled` y envió el ACK (`outcome` en `chatbot_feed_items`).
- Prueba del SSE (1.3) cuando haya una hora tranquila.

## 7. Rollback

- **La vuelta atrás completa de datos es el backup de 4.1**; implica perder lo escrito desde entonces. Las migraciones **no tienen «down»**.
- **Rollback de la app (redeploy de la imagen de `origin/main` anterior, `bd53a983`)** es compatible con el esquema nuevo: las 15 migraciones son aditivas y lo único que cambia en una tabla existente es `service_credentials."rateLimits"` (nullable, que el código viejo ignora). Los triggers están solo en tablas nuevas. La app vieja no borra filas de `human_decisions`, `delivery_zone_requests` ni `receipt_evidences` (no hay `delete` en `src/`), que son las que las FKs nuevas protegen. Costos del rollback: (a) la app vieja no cierra las solicitudes envueltas cuando se resuelve por las pantallas viejas, así que al volver a desplegar la nueva hay que correr `backfill-chatbot-requests.cjs --check` y, si lista `STATE_DISAGREES`, resolver esas solicitudes por la ruta común; (b) el bot nuevo deja de funcionar contra la app vieja: volvé al bot viejo.
- **Datos que no se deshacen:** el backfill (`--apply`) y las solicitudes, eventos y mensajes creados (los triggers `chatbot_requests_keep_forever` y de solo-agregar impiden borrarlos). Se corrigen con comandos normales (cancelar con motivo), no borrando (runbook del backfill, «Roll back»).
- **Una migración que vence por lock:** sección 3.4. Nada queda a medias dentro de esa migración.
- **Permisos y scopes:** se quitan con SQL (borrar las filas `RolePermission` nuevas o quitar los scopes del arreglo); no hace falta tocar la app.
- Desactivar una credencial: `UPDATE "service_credentials" SET "isActive"=false, "revokedAt"=now() WHERE "name"='chatbot-whatsapp';` (como en el checklist de lanzamiento).

## Riesgos y decisiones que necesitan al dueño

1. **Estado real de las migraciones de producción** (3.1): si está detrás de `origin/main`, este deploy arrastra migraciones del checklist de lanzamiento (inventario escribe datos). Confirmalo con el `SELECT`.
2. **¿Hay deploy automático al hacer push a `main`?** Si sí, el push es el deploy: los pasos previos (backup, comprobar `DATABASE_URL`/Spaces, hora) se hacen antes. No lo pude verificar desde el repo.
3. **Recuperación con contenedor en bucle** y política de actualización del Swarm (¿arranca el nuevo antes de apagar el viejo?): no está probado (3.4). El recorrido de la migración fallida depende de eso.
4. **Handler de aclaraciones del chatbot (unidad 10):** sin él, una respuesta del staff a una aclaración se ACKea `STALE` y el cliente nunca la recibe. Decidir si el frontend muestra el botón «Responder» recién cuando el bot lo tenga (L127: «pending chatbot handler»).
5. **Pendientes viejos y la ráfaga** (4.4 paso 3): decisión según `oldestOpenAt` del dry-run (resolverlos antes, o aceptar la ráfaga de avisos al staff).
6. **`LISTEN` por conexión directa y `max_connections`** (4.5): no verificado en producción.
7. **SSE no probado en Traefik/Swarm** (1.3): el frontend se queda con polling.
8. **Los scripts de duplicados y backfill solo corren con la imagen nueva**: no existe un reporte de duplicados previo al deploy; es informativo, no bloquea.
9. **Corrida aislada de human-decisions** anterior a las unidades 9-10 (2.2; sin cambios en esas carpetas desde entonces, repetirla igual) y **deriva schema/migraciones sin comprobar** (2.3).
10. **Rotar `JWT_SECRET` ahora invalida los `customerKey` sellados** (4.5).
