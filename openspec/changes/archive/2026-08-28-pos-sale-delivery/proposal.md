# POS sale "for delivery" at charge time

Allow a POS (mostrador) cashier to flag a sale **for delivery** at charge time via an optional boolean on `ChargeSaleDto`, so the confirmed sale becomes `deliveryStatus: 'PENDING'` and eligible to join a `DeliveryRoute`. Today POS sales are born `DELIVERED` at draft creation and can never be routed, even when the customer actually wants delivery.

Product decisions are fixed and are **not** re-opened by this proposal: flag moment is charge time only; the flag sets `PENDING` only (route check-in already flips `PENDING → DELIVERED` via `Sale.markDelivered()`); `SHIPPED` is bot/ONLINE-only and out of scope; a non-null `shippingAddressId` is required; no new CASL permission.

## Problem

- POS drafts are seeded with `deliveryStatus: 'DELIVERED'` (`Sale.create`, `src/sales/domain/sale.entity.ts:210-227`) and `PrismaSaleRepository.save` persists that on every save (`prisma-sale.repository.ts:108`).
- `chargeDraft` calls `persistChargeConfirmation` **without** `deliveryStatus` (`sales.service.ts:2605-2636`); the repository's conditional-write rule (`prisma-sale.repository.ts:946-947`) means the confirmed sale keeps the draft's `DELIVERED`.
- `DeliveryRoute.create`/`addStop` reject any sale whose `deliveryStatus` is neither `PENDING` nor `SHIPPED` (`delivery-route.entity.ts:209-227, 329-346`) → a POS delivery sale can **never** be routed.

## Current state vs desired state

| Aspect | Current | Desired |
|--------|---------|---------|
| POS charge payload | no delivery signal | optional `delivery?: boolean` on `ChargeSaleDto` |
| Confirmed POS sale status | `DELIVERED` (inherited from draft) | `PENDING` when flag set (and `shippingAddressId` present) |
| Route eligibility | ineligible forever | eligible (`PENDING` + non-null `shippingAddressId`) |
| Missing address + flag | n/a (flag doesn't exist) | charge fails with clear 422 business-rule error |
| Idempotency key replay | hashes `saleId, actorId, payments, dueDate` (`sales.service.ts:2416-2424`) | hash MUST include the delivery flag |
| Permission | `update:Sale` on the charge route | unchanged — reuse `update:Sale`, no CASL change |

## Scope

**In scope**

1. `ChargeSaleDto` (`src/sales/dto/charge-sale.dto.ts`): add `@IsOptional() @IsBoolean() delivery?: boolean` (add `IsBoolean` to the existing `class-validator` import).
2. `chargeDraft` (`src/sales/sales.service.ts`, validation guard cluster ~2540-2560): when `dto.delivery === true`, require non-null `sale.shippingAddressId`; otherwise throw a 422 business-rule error (new code, e.g. `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`) and **do not** persist.
3. Persist the flag: pass `deliveryStatus: dto.delivery ? 'PENDING' : 'DELIVERED'` explicitly to `persistChargeConfirmation` (matches how `confirmBotSale` passes `'PENDING'` explicitly, `sales.service.ts:2976-2978`). Optional: mirror the guard in a draft-only `Sale.markForDelivery()` domain method per `ensureDraft()` + guard pattern of `setShippingAddress`/`markDelivered` — apply-phase decision, either shape must satisfy the same behavior.
4. Idempotency: include the `delivery` flag in the charge `requestHash` (`sales.service.ts:2416-2424`).
5. Repository: **no signature change** needed — `PENDING` already exists in both the interface union (`sale.repository.ts:215`) and impl union (`prisma-sale.repository.ts:896`).
6. Tests: extend `sales.service.spec.ts` `chargeDraft` block (flag+address → `deliveryStatus: 'PENDING'`; flag+no address → throws, no persist; flag omitted → current behavior; idempotency hash includes flag), plus `sale.entity.spec.ts` if a domain method is added.

**Non-goals (explicit)**

- `SHIPPED` for POS sales — the `PENDING → SHIPPED` leg is bot/ONLINE-only (`chatbot-api.service.ts:412-425` requires `channel === 'ONLINE'`); POS delivery sales stay `channel: 'POS'`. Out of scope.
- Real-time tracking, map/pin display, geocoding.
- DeliveryRoute eligibility changes, delivery-fee pricing, or dispatch UI.
- Widening the `ListSalesDeliveryStatus` filter enum (`list-sales-query.dto.ts:34-38`, pre-existing gap).
- New CASL action/permission (`AppActions`/registry/seeding untouched).

## Success criteria / acceptance

- [x] `POST /sales/drafts/:id/charge` with `{ "delivery": true }` and a non-null `shippingAddressId` confirms the sale with `deliveryStatus: 'PENDING'`; the row is eligible for `DeliveryRoute.create`/`addStop` (route check-in flips it `DELIVERED`).
- [x] Same payload with null/absent `shippingAddressId` fails with 422 and a clear business-rule error; `persistChargeConfirmation` is not called.
- [x] Flag omitted or `false` reproduces today's behavior exactly (no `deliveryStatus` drift).
- [x] Retrying the same `idempotency-key` with a changed `delivery` flag does **not** replay a stale non-delivery result (hash includes the flag).
- [x] No CASL change; `update:Sale` still covers the charge route.
- [x] `pnpm test` and `pnpm build` pass.

## Affected areas

- `src/sales/dto/charge-sale.dto.ts` — DTO field.
- `src/sales/sales.service.ts` — `chargeDraft` validation + `deliveryStatus` pass-through + idempotency hash.
- `src/sales/domain/sale.entity.ts` — only if the `markForDelivery()` domain-method shape is chosen.
- `src/sales/sales.service.spec.ts` (+ `sale.entity.spec.ts` if applicable).
- No repository, migration, schema, or authorization changes.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Idempotency hash drift — flag omitted from `requestHash` silently returns a non-delivery replay | High | Acceptance criterion #4; hash MUST include `delivery` |
| Cancel-while-PENDING — `Sale.cancel` allows cancelling `PENDING` sales (`sale.entity.ts:336-337` blocks only SHIPPED/DELIVERED) | Low | Accepted semantics; a flagged-but-uncancelled sale is eligible until route check-in flips it |
| Repo union mismatch — impl type lacks `'SHIPPED'` (`prisma-sale.repository.ts:896` vs interface `:215`) | Low, latent | Not blocking for `PENDING`; optionally reconcile in this change |
| List-filter enum lacks `SHIPPED` (`list-sales-query.dto.ts:34-38`) | Low, pre-existing | Out of scope; POS delivery sales filter via `PENDING` today |
| POS `PENDING → SHIPPED` leg does not exist | Medium, product-scoped | Explicit non-goal; chatbot guard rejects POS channel, so no accidental SHIPPED writes |

## Rollback plan

Feature is additive — no schema change, no migration, no permission seeding.

- **Revert path:** remove the `delivery` field from `ChargeSaleDto` and the `chargeDraft` flag handling (guard, `deliveryStatus` pass-through, hash inclusion); behavior returns to today's semantics.
- **Data consideration:** rows confirmed with `PENDING` while the feature is live are already route-eligible — that is the intended outcome, not a side effect. If reverted, any `PENDING` POS rows remain eligible for routing (unchanged behavior for `PENDING` in `DeliveryRoute`), and route check-in still flips them to `DELIVERED`; no backfill or data repair required.
- **Release note:** ship as a single revertible commit; no migration step means rollback is a code-only change.

## Open questions

None. All product decisions (flag moment, `PENDING`-only semantics, address requirement, no new permission, `SHIPPED` exclusion, idempotency inclusion) were fixed by the parent before this phase and are recorded in `openspec/changes/pos-sale-delivery/explore.md`.
