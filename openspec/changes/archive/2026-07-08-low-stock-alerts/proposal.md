# Proposal: Low-Stock Email Alerts

## Intent

Today stock can silently run below `minQuantity` on a product or variant and the
client only learns at the next sale attempt or audit. This change introduces a
**one-shot email alert** on the downward crossing and ships the
**reusable** Sistema → Configuración → Notificaciones module behind it. Low-stock
email is the first consumer; future notifications (leads, recruitment, etc.)
reuse the same per-tenant config, CASL subject, and Inngest engine. Goal: never
run out of stock unnoticed — without re-alerting every checkout.

## Scope

### In Scope

- `src/notification-config/` bounded context: `NotificationSettings` (master toggle
  per tenant), `NotificationRecipient` (single per-tenant list), `NotificationAction`
  (enum-driven enabled actions; ships `LOW_STOCK` only).
- New Prisma models + migration; new `StockAlertState` table for edge state.
- CASL: new `NotificationConfig` subject with `read` + `update` actions, GRANTABLE
  via DB `RolePermission` rows (no hardcoded role). Mirrors `SatKey` precedent.
- HTTP API consumed by the Configuración → Notificaciones UI: get/update config,
  set recipients, toggle actions.
- Resend-backed email send (React Email template) with full content: product name,
  affected variant, current qty, configured min, SKU/code, category, deep link.
- Inngest wired into Nest: `serve()` mounted via a controller; an `InngestService`
  provider that builds `createFunction(...)` over DI-injected ports. Dev Server
  locally; Inngest Cloud in staging/prod.
- Edge-triggered detection at the product level (no variants) and variant level;
  one-shot guarantee via atomic conditional flip + Inngest idempotency.
- Re-arm when restock brings quantity back `>= minQuantity` and a later drop occurs.
- Coalescing: distinct near-simultaneous crossings grouped into ONE email via
  Inngest batching/debounce. Edge-trigger stays one-shot per product/variant.

### Out of Scope

- **Lots / expiration alerts** (`useLotsAndExpirations`).
- **Per-action recipients** (model stays additive-ready).
- **Other modules** (leads, recruitment, etc.) — enum reserves space only.
- **In-app / push / SMS** channels; digest-as-only mode; quiet hours.
- **Orders-path** decrement — sales/charge path only in v1; orders reuses the same
  emitter later (additive).

## Capabilities

### New Capabilities

- `notification-config`: per-tenant notification configuration (master on/off,
  single recipient list, enabled actions). Provides the REST API consumed by
  Configuración → Notificaciones.
- `stock-alerts`: edge-triggered low-stock detection (one-shot on downward
  crossing; re-arm on restock) coalesced into a single Resend email per
  batching window.

### Modified Capabilities

- `sales`: `IProductRepository.decrementStockForCharge` signature changes from
  `Promise<void>` to return crossing info per adjustment
  (`{ productId, variantId, newQuantity, minQuantity }[]`). Sales orchestrator
  collects crossings in-tx and dispatches to Inngest strictly AFTER commit.

## Approach

```
src/notification-config/         # bounded context (domain / infra / dto / http / service / module)
src/inngest/                    # InngestService (DI-bridged client + functions) + serve controller
src/notifications/email/        # Mailer port + Resend adapter + React Email template
prisma/schema.prisma            # +NotificationSettings, NotificationRecipient, NotificationAction,
                                #  NotificationActionKey enum, StockAlertState
src/products/infrastructure/    # decrementStockForCharge returns crossings (variant + product paths)
src/products/domain/events/     # stock events carry tenantId, variantId?, newQuantity, minQuantity
src/sales/sales.service.ts      # buffer crossings in-tx, dispatch AFTER runInTransaction resolves
src/sales/listeners/            # new handler: after-commit -> InngestService.send('stock/low.detected')
src/auth/authorization/...      # +NotificationConfig subject + read/update registry rows + seeder upsert
src/main.ts                     # wire Inngest before app listen; env-driven signing/event keys
package.json                    # +inngest, resend, @react-email/components, react, react-dom
```

- **Dispatch**: in-tx collect → `runInTransaction` resolves → `@nestjs/event-emitter`
  `stock/low.detected` listener → `InngestService.send()` with `tenantId` always
  in payload (CLS never runs inside Inngest handlers).
- **Inngest function** (3 durable steps): `load-config` (gate on master +
  `LOW_STOCK`) → `resolve-recipients` (User.email, `isActive`, dedupe) →
  `send-email` (Resend, React Email). Coalescing via Inngest batch key on
  `(tenantId, LOW_STOCK, batching window)`.
- **One-shot**: atomic `updateMany` flip on `StockAlertState` inside the SAME tx
  as the decrement (`count===1` = owns alert). `incrementStockForRestock` clears
  `alerted=false` when quantity returns `>= minQuantity`.

## Locked Decisions (carried verbatim from explore)

| # | Decision | Rule |
|---|----------|------|
| 1 | Threshold source | Reuse existing per-product / per-variant `minQuantity` |
| 2 | Trigger boundary | Fire when `quantity <= minQuantity` (per product when no variants; per variant otherwise) |
| 3 | Cadence | One-shot per product/variant on downward crossing; re-arm only after restock above `minQuantity` then a later drop |
| 4 | Coalescing | Distinct near-simultaneous crossings merged into ONE email via Inngest batching; edge-trigger remains one-shot per item |
| 5 | Email content | Full content + category + deep link |
| 6 | Recipients | Single per-tenant list (email = user's account email); model additive-ready for per-action later |
| 7 | Access control | CASL `NotificationConfig`, GRANTABLE via DB `RolePermission` rows — no role hardcoded; whoever holds `read`/`update:NotificationConfig` can access Configuración → Notificaciones |
| 8 | Default state | OFF per tenant until explicitly configured |
| 9 | Engine / provider | Inngest (durable workflow), Resend (email) |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | New | `NotificationSettings`, `NotificationRecipient`, `NotificationAction`, `NotificationActionKey` enum, `StockAlertState` (composite unique) |
| `prisma/migrations/<ts>_low_stock_alerts/` | New | Migration + indexes |
| `src/notification-config/` | New | Full bounded context (hexagonal) |
| `src/inngest/` | New | `InngestService` + DI-bridged functions + serve controller (excluded from JWT guard) |
| `src/notifications/email/` | New | Mailer port + Resend adapter + React Email template |
| `src/products/infrastructure/prisma-product.repository.ts` | Modified | `decrementStockForCharge` returns crossings for variant + product paths |
| `src/products/domain/events/product.events.ts` | Modified | Stock events carry `tenantId`, `variantId?`, `newQuantity`, `minQuantity` |
| `src/sales/sales.service.ts` | Modified | Buffer crossings; dispatch strictly AFTER `runInTransaction` resolves |
| `src/sales/listeners/sale-event.listener.ts` | New handler | After-commit → `InngestService.send('stock/low.detected')` |
| `src/auth/authorization/domain/permission.ts` | Modified | `NotificationConfig` in `AppSubjects` + `read`/`update` registry rows |
| `src/auth/authorization/seed/permission.seeder.ts` | Modified | Idempotent upsert of the new permission keys |
| `src/main.ts` | Modified | Wire Inngest before listen; env-driven signing/event keys |
| `package.json` | New deps | `inngest`, `resend`, `@react-email/components`, `react`, `react-dom` |
| Tests | New | Notification-config specs; updated repo signature spec; Inngest function specs (mocked client); listener spec; auth/permission seed spec |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **R1** Tenant context loss in Inngest handlers (CLS never runs) | High | Every payload carries `tenantId`; handler body wrapped in `runWithTenant(tenantId, fn)` |
| **R2** Phantom alerts on tx rollback + network-in-tx latency | High | Buffer crossings in-tx; emit/send strictly AFTER `runInTransaction` resolves |
| **R3** Two concurrent sales both cross threshold | Med | Atomic conditional flip on `StockAlertState` (`updateMany count===1` owns alert) + Inngest idempotency key `tenantId+productId+variantId+alertEpoch` |
| **R4** `decrementStockForCharge` returns void today; needs post-quantities | Med | Switch variant/product branches from `updateMany` (count only) to `update` returning the row, OR single read-back inside the tx. Strict TDD; call sites + spec must update |
| **R5** Greenfield surface likely > 400-line review budget | High | Tasks phase plans chained work units: (a) schema + migration; (b) `notification-config` bounded context + API + CASL; (c) Inngest wiring + serve + dev server; (d) `StockAlertState` + edge detection + repo signature; (e) email send + React Email + coalescing; (f) listeners + after-commit glue + tests |
| **R6** Resend from-domain / env not yet wired | Med | Apply phase asks user for `RESEND_API_KEY` + verified sender domain; dev fallback logs the rendered email when env is unset |
| **R7** Coalescing window length unspecified | Med | Pick a small default (e.g. 60s) at design time; per-action override later |
| **R8** `useLotsAndExpirations` products in scope creep | Low | Explicitly out; gating at `useLots=false && hasVariants-influenced` path in spec |

## Rollback Plan

- **Schema**: down-migration drops `StockAlertState`, `NotificationSettings`,
  `NotificationRecipient`, `NotificationAction`, `NotificationActionKey` enum.
  `Product` / `Variant` / `Lot` unchanged.
- **Code**: revert the feature branch. The only signature change is
  `decrementStockForCharge` → confined to the repo + its spec + the two call
  sites (`sales.service`, `orders.service`); no semantic change to decrement.
- **Inngest**: removing `InngestModule` + the serve controller disables the
  bridge; the app boots and serves existing endpoints with no new network calls.
- **Email**: Resend adapter is behind a mailer port; swapping to a no-op logger
  port keeps everything else working on rollback.
- **No destructive changes** to existing data.

## Dependencies

- **External env (supplied at apply)** — `RESEND_API_KEY` + verified sender domain;
  Inngest event key + signing key (staging/prod). Dev Server needs neither.
- **Internal ordering**: Prisma migration → `notification-config` module →
  Inngest wire → edge detection + repo signature → email send + coalescing.
  CASL registry + seeder ride alongside `notification-config`.
- **No DB extensions** required for v1.

## Success Criteria

- [ ] `GET /notification-config` returns `{ enabled, recipients[], enabledActions[] }`
- [ ] `PUT /notification-config` updates master + recipients + actions; new tenants default to `enabled=false`
- [ ] Endpoint requires `read:NotificationConfig` / `update:NotificationConfig` (HTTP 403 otherwise)
- [ ] When stock crosses to `<= minQuantity`, exactly ONE Inngest function invocation per product/variant; concurrent crossings collapse to one send via batching
- [ ] Restock `>= minQuantity` then a later drop re-fires (StockAlertState re-arm)
- [ ] Email body contains product name, affected variant, current qty, configured min, SKU/code, category, deep link
- [ ] Tx rollback produces NO outbound Inngest event
- [ ] `pnpm test` green; review budget ≤ 400 changed lines per work unit on the branch
