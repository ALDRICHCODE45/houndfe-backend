# Proposal: Bot Sale Domain Events & Invariants

## Intent

`registerBotSale` writes a CONFIRMED CREDIT sale via direct Prisma, bypassing the `SalesService` domain layer (W-004) and emitting NO domain/outbox events (S-004). It also silently skips SIX invariants the human-cashier path enforces. This causes invariant drift, missing folios, unsynced stock, and zero downstream event signals for bot-created sales. Route bot sales through the domain layer so they are first-class sales.

## Scope

### In Scope
- New `SalesService.confirmBotSale()` method enforcing all SIX invariants: folio allocation, stock decrement, domain/outbox events, credit `dueDate` (confirmedAt + 15d), price validation, seller assignment.
- Emit `sale.confirmed` outbox event (no payments at creation → no `sale.payment.received`/`sale.fully.paid`).
- Route `registerBotSale` through `confirmBotSale`; idempotency stays in `ChatbotApiService`.
- Module wiring: `ChatbotApiModule` imports `SalesModule`.
- Strict-TDD tests: `sales.service.spec.ts` + `chatbot-api.service.spec.ts`.

### Out of Scope
- Anything in the separate `houndfe-chatbot` repo.
- Multi-bot credential isolation (W-003).
- Hardening items W-001, W-002, S-001.
- Data/dueDate backfill migrations — greenfield (see Assumptions).

## Capabilities

### New Capabilities
- None — no new spec-level capability is introduced.

### Modified Capabilities
- `sales`: bot-channel sale confirmation now enforces the full domain invariant set and emits `sale.confirmed`, matching the human-cashier confirmation contract.

## Assumptions

- **Greenfield**: the bot has NEVER created a sale. Zero legacy bot-sale rows exist, so no backfill (stock, folio, or dueDate) is needed. This removes all migration risk.
- **Stock behavior change is intended**: bot sales WILL decrement stock exactly like a cashier sale. Accepted by the owner.

## Approach

**Approach A** — add a purpose-built `SalesService.confirmBotSale()` that creates a confirmed sale in one step (no draft→charge lifecycle) reusing folio allocation, stock decrement, dueDate computation, persistence, and outbox emission. `registerBotSale` delegates to it. Single source of truth eliminates drift (W-004). `ChatbotApiModule → SalesModule` is safe: `SalesModule` does not import `ChatbotApiModule`, so no circular dependency.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/sales/sales.service.ts` | New | `confirmBotSale()` method |
| `src/sales/sales.service.spec.ts` | Modified | Invariant + event tests |
| `src/chatbot-api/application/chatbot-api.service.ts` | Modified | Delegate `registerBotSale` |
| `src/chatbot-api/application/chatbot-api.service.spec.ts` | Modified | Delegation + idempotency tests |
| `src/chatbot-api/chatbot-api.module.ts` | Modified | Import `SalesModule` |
| `src/sales/domain/events/sale.events.ts` | Reused | Existing `sale.confirmed` event |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Review size: 6 invariants + strict TDD may exceed 400-line budget | High | Flag in tasks phase to forecast; chained-PR if needed |
| Folio sequence now shared with POS sales | Low | Intended — bot sales are real sales |
| Outbox payload must be plain objects, not class instances | Med | Build plain payloads in `confirmBotSale` |
| New `ChatbotApiModule → SalesModule` coupling | Low | Verified no circular dep |

## Rollback Plan

Revert the commit(s). `ChatbotApiModule` drops the `SalesModule` import and `registerBotSale` returns to the direct Prisma write. No data migration to undo (greenfield), so rollback is purely code.

## Dependencies

- `OutboxModule` (already exported via `SalesModule`'s dependency graph).

## Success Criteria

- [ ] `confirmBotSale` allocates a folio, decrements stock, sets dueDate, assigns seller, validates prices.
- [ ] A bot sale emits exactly one `sale.confirmed` outbox event with correct payload.
- [ ] `registerBotSale` delegates to `confirmBotSale` and preserves idempotency behavior.
- [ ] `sales.service.spec.ts` and `chatbot-api.service.spec.ts` pass under strict TDD.
- [ ] No circular dependency; app boots with `ChatbotApiModule` importing `SalesModule`.
