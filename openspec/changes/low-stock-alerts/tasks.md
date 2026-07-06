# Tasks: Low-Stock Email Alerts

## Slice A — Schema
- [x] A.1 RED `tenant-scoped-models.spec.ts` — 4 new models. GREEN add to `src/shared/tenant/tenant-scoped-models.constant.ts`.
- [x] A.2 RED `permission-registry.spec.ts` + `permission.seeder.spec.ts` — `(NotificationConfig,read|update)` + idempotent. GREEN add to `AppSubjects` + `PERMISSION_REGISTRY` in `src/auth/authorization/domain/permission.ts`.
- [x] A.3 RED `low-stock-migration-drift.spec.ts` — excludes `employee_emergency_contacts` + 5 new objects only. GREEN add 4 models + enum + back-relations + restore `updatedAt @updatedAt` on `EmployeeEmergencyContact`; `prisma migrate dev --create-only --name low_stock_alerts`; verify diff.

## Slice B — notification-config Domain + Prisma
- [x] B.1 RED `notification-config.repository.spec.ts` — `find`+`replace`. GREEN `domain/notification-config.repository.ts` + token + `dto/update-notification-config.dto.ts`.
- [x] B.2 RED `prisma-notification-config.repository.spec.ts` — empty defaults / populated / full overwrite / unknown key throws. GREEN `infrastructure/prisma-notification-config.repository.ts`.

## Slice C — Service + Controller + Module
- [x] C.1 RED `notification-config.service.spec.ts` — read delegates / `UNKNOWN_ACTION_KEY` throws / empty defaults. GREEN `notification-config.service.ts`.
- [x] C.2 RED `notification-config.controller.spec.ts` — GET 200/403 / PUT 200/403/400 / tenant isolation. GREEN `notification-config.controller.ts` + DTOs + guards + `@RequirePermissions`.
- [x] C.3 GREEN `notification-config.module.ts` wires port+adapter+service+controller.

## Slice D — Inngest
- [x] D.1 RED `tenant-runner.service.spec.ts` — CLS seeded (`tenantId`/`SYSTEM`/`isSuperAdmin=false`) + fn runs. GREEN `src/shared/tenant/tenant-runner.service.ts`.
- [x] D.2 RED `inngest.service.spec.ts` — client ctor + `send(name,data,idempotencyKey)` + `getFunctions()`. GREEN `src/inngest/inngest.service.ts`.
- [x] D.3 RED `inngest.controller.spec.ts` — JWT-excluded + delegates to `serve()` + unsigned reject. GREEN `src/inngest/inngest.controller.ts`.
- [x] D.4 RED `app-bootstrap-env.spec.ts` — Joi fails missing `NODE_ENV`/keys. GREEN extend `src/app.module.ts` Joi w/ `NODE_ENV.valid(...).required()` + key conditionals.

## Slice E — Stock Crossing
- [ ] E.1 RED `prisma-stock-alert-state.repository.spec.ts` — flip `count===1` / `count===0` re-flip. GREEN `prisma-stock-alert-state.repository.ts` w/ `INSERT ... ON CONFLICT DO NOTHING` + guarded `UPDATE ... RETURNING "alertEpoch"`.
- [ ] E.2 RED extend `prisma-product.repository.spec.ts` + `products.service.spec.ts:30` — `StockCrossing[]`; PRE-gate; variant; lots excluded; cross-tenant throws; in-tx outbox; strict `>` re-arm. GREEN rewrite w/ raw `$queryRaw` UPDATE…RETURNING + flip + outbox; update `src/products/products.service.ts:100-108`.
- [ ] E.3 RED extend `sales.service.spec.ts` — crossings in-tx / dispatched AFTER `runInTransaction` / rollback→no send / payload enriched / `mockResolvedValue(undefined)`→`mockResolvedValue([])`. GREEN `sales.service.ts:1643` + `:1918` capture + post-commit dispatch; inject `InngestService`.
- [ ] E.4 RED integration spec (real DB) — 2 concurrent txs: one `count===1`, other `count===0` under READ COMMITTED.

## Slice F — Email + Dispatch
- [ ] F.1 RED `mailer.port.spec.ts` + `resend-mailer.spec.ts` — `MAILER.send({to[],subject,html})`; dev redacts recipients; prod w/o key throws. GREEN `mailer.port.ts` + `resend.mailer.ts` + `templates/low-stock.email.tsx`.
- [ ] F.2 RED `low-stock.functions.spec.ts` — coalesce / short-circuits / dedupe / replay idempotent / fields. GREEN `low-stock.functions.ts` w/ `batchEvents:{maxSize:50,timeout:'60s',key:'event.data.tenantId'}`, `idempotency:event.id`, `step.run`s in `runWithTenant`.
- [ ] F.3 RED extend `outbox-poller.service.spec.ts` — SELECT contains `AND "eventType" <> 'stock.low.detected'`; non-alert still claimed. GREEN add predicate to `src/shared/outbox/outbox-poller.service.ts:48-60`.
- [ ] F.4 RED `low-stock-outbox.poller.spec.ts` — claims ONLY `status='PENDING' AND "eventType"='stock.low.detected' AND "nextAttemptAt" <= NOW()` + lockedUntil; SKIP LOCKED + lockToken. GREEN `src/stock-alerts/outbox/low-stock-outbox.poller.ts` `@Interval`.
- [ ] F.5 RED `low-stock-outbox.dispatcher.spec.ts` — AWAIT `send`; resolve→`PUBLISHED`; reject→`PENDING`+`retryCount++`+bumped`nextAttemptAt`+`lastError`; maxRetries→`FAILED`; replay→mailer once. GREEN `src/stock-alerts/outbox/low-stock-outbox.dispatcher.ts`.
- [ ] F.6 Tests + `prisma migrate status` + `tsc --noEmit` green.

## Review Workload Forecast

Branch `feat/low-stock-alerts`; merge to `main`. ~1820 lines total.

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium