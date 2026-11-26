# Proposal: per-register drawer hold on `GET /cash-registers`

Status: **implemented** on branch `feat/cash-register-held-by` (not merged, not pushed, not deployed). The frontend approved it and answered the open questions (see "Decisions" below). Frontend contract: [docs/frontend-handoff/25-cash-redesign.md §7](../frontend-handoff/25-cash-redesign.md). Originally requested by the frontend session: the «Abrir caja» selector marks a register as «Disponible» even though it has an unreleased session, and then `POST /cash-registers/:id/sessions` fails with 422 `CASH_REGISTER_UNRELEASED_SESSION`.

## Problem

- The open-session guard blocks any register that has a session with `drawerReleasedAt IS NULL`, **whatever its status** (E3). A `CLOSED` session whose drawer was never released still blocks the register.
- Today `GET /cash-registers` only returns `{ id, name, isActive, createdAt }` (E2). It has no availability field (**EXISTS**: nothing to reuse).
- The frontend workaround, `GET /cash-sessions?drawerOpen=true` (E5), applies the session list visibility rule. Without `read:CashSessionAudit` the caller only sees their **own** sessions (E6, E7), so another cashier's unreleased drawer stays invisible and the register still shows «Disponible».

## Implemented shape (additive)

Each item in `GET /cash-registers` gets four new fields. Existing fields stay as they are.

```ts
{
  id, name, isActive, createdAt,            // EXISTS, unchanged
  drawerHeld: boolean,                      // NEW — always present
  drawerHeldStatus: 'OPEN' | 'COUNTING' | 'SUBMITTED' | 'CLOSED' | null, // NEW — set iff drawerHeld, every caller
  drawerHeldSince: string | null,           // NEW — ISO openedAt of the holding session, set iff drawerHeld, every caller
  heldBy: null | {                          // NEW — non-null only when drawerHeld AND the caller may see that session
    sessionId: string,
    status: 'OPEN' | 'COUNTING' | 'SUBMITTED' | 'CLOSED',
    openedAt: string,                       // ISO
    cashierDisplayName: string | null,
    byMe: boolean,
  }
}
```

**Implemented:** always send `drawerHeld`, plus `drawerHeldStatus`/`drawerHeldSince` whenever it is true (no name). Fill in `heldBy` only when the caller has `read:CashSession` (the gate `GET /cash-sessions` applies first) and `isSessionVisible(actor, session)` is true, meaning it is the caller's own session or the caller has `read:CashSessionAudit` (E7). Independent verify found the first gate missing; fixed with a test for audit without `read:CashSession`. The rest of the time, send `heldBy: null` while `drawerHeld: true`.

Why:

- `drawerHeld` alone fixes the reported bug for every cashier. The selector can show «Ocupada» and disable the register. It reveals no more than the 422 already does (E4 details already carry `sessionId`).
- Showing the person's name is gated by the **same** rule that already decides who sees `cashierDisplayName` in `GET /cash-sessions` (E6, E8). So this does not create a new privacy decision. It just reuses the existing session visibility boundary. Supervisors (audit) get the full «Ocupada por Ana desde 09:12». An ordinary cashier sees «Ocupada» for someone else's register and their own session details for their own register (`byMe: true`, which can link to «Continuar / Liberar caja»).
- Precedent: colleague display names are already exposed to non-audit users, but only through a narrower, purpose-specific grant (`read:CashHandover` → handover recipients, E9). That does not justify showing names on a plain `read:CashRegister`, so the default stays conservative. See open question 1.

## Same predicate as the 422

- Pull the guard's filter out into one helper, e.g. `unreleasedSessionWhere(tenantId, registerIds)` = `{ tenantId, registerId: { in: registerIds }, drawerReleasedAt: null }`. Use it in both `openSession` (E3) and `queryRegisters` (E2). Then the selector and the error cannot disagree on the rule.
- `status` is **not** part of the predicate. It is reported only for display.
- The DB already enforces "at most one unreleased session per register" with the partial unique index `cash_sessions_one_unreleased_per_register` (E10, corrected). Opening also serializes on a register row lock (E11). The projection still picks deterministically (latest `openedAt`, then `id`) as a defense. Implemented in `src/cash-register/infrastructure/cash-adapter-drawer-hold.ts` (`unreleasedSessionWhere`, `registerDrawerHolds`).

## Query cost

- One extra batched query per request, no N+1: `cashSession.findMany({ where: unreleasedSessionWhere(tenantId, visibleRegisterIds), orderBy: [{ openedAt: 'desc' }, { id: 'desc' }] })`. Then one `userNames` lookup (E8), and only for the sessions that end up in `heldBy`.
- **Correction:** the partial index this proposal suggested already exists, and it is unique: `cash_sessions_one_unreleased_per_register ON cash_sessions ("tenantId","registerId") WHERE "drawerReleasedAt" IS NULL` (migration `20261007000100_cash_register_closing`, line 111). It matches the predicate exactly, so it serves the lookup. No new migration was added, because a second non-unique index would only be a duplicate.
- The value is computed only for registers that already passed the per-row `read:CashRegister` filter (E2).

## Snapshot semantics (frontend must keep handling the 422)

`drawerHeld` is a read-time snapshot taken without locks. Another device can open or release the register between the list and the POST. `POST …/sessions` stays the authoritative check, under the register row lock (E3, E11). The frontend must keep mapping the 422 `CASH_REGISTER_UNRELEASED_SESSION` to «La caja tiene una sesión sin liberar» and refresh the list. The same "hint, not a guarantee" wording already appears in the custody and recipients modules (E9, E12).

## Compatibility

Purely additive response fields. No new route, permission, query param, or migration. Existing clients ignore the new fields.

## Tests that would pin it

Extend `src/cash-register/infrastructure/cash-adapter-queries.spec.ts` (current register tests start at E13). Add one facade-level case in `cash-adapter-custody-queries.spec.ts` (E14):

1. No sessions, or only released sessions → `drawerHeld: false, heldBy: null`.
2. A `CLOSED` session with `drawerReleasedAt = null` → `drawerHeld: true`. This pins that status is not the predicate.
3. Caller's own unreleased session → `heldBy.byMe = true` with `cashierDisplayName`.
4. Another cashier's session, caller has no audit grant → `drawerHeld: true, heldBy: null` (privacy).
5. Same as 4 with `read:CashSessionAudit` → full `heldBy`.
6. **Parity:** for each register, `drawerHeld === true` ⇔ `openSession` throws `CASH_REGISTER_UNRELEASED_SESSION`.
7. Release the drawer → the next list shows `drawerHeld: false`.

The in-memory `makeTenantHarness` already supported `registerId: { in: [...] }`, so no harness change was needed.

Implemented coverage: all 7 cases above, plus `drawerHeldStatus`/`drawerHeldSince` without a name for a non-visible caller (COUNTING), an inactive register, the deterministic pick with two unreleased sessions (in-memory only, since the DB forbids it), a missing cashier user (`cashierDisplayName: null`), one batched session query over only the per-row-visible registers with one name lookup limited to `heldBy` rows, and no lookups when no register is visible. Files: `cash-adapter-queries.spec.ts`, `cash-adapter-custody-queries.spec.ts` (facade parity and release), and `prisma-cash-register.held-by.integration.spec.ts` (real PostgreSQL: shape, privacy, parity with the 422 including a CLOSED unreleased session).

## Size

Small, about S: one helper, roughly 30 lines in `queryRegisters`, a one-line change in `openSession`, and about 7 tests. No migration.

## Evidence (EXISTS)

- E1 `src/cash-register/presentation/cash-register.controller.ts:57-66`: `GET /cash-registers` requires `read:CashRegister` and dispatches query `REGISTERS`.
- E2 `src/cash-register/infrastructure/cash-adapter-queries.ts:60-91`: `queryRegisters` filters per row with `canInstanceAbility` and returns `{ id, name, isActive, createdAt }` only.
- E3 `src/cash-register/infrastructure/cash-adapter-opening.ts:100-109`: the guard `findFirst({ tenantId, registerId, drawerReleasedAt: null })` throws `REGISTER_UNRELEASED_SESSION` (no status filter).
- E4 `src/cash-register/application/cash-application.errors.ts:26,58-64` and `src/shared/filters/domain-exception.filter.ts:83`: code `CASH_REGISTER_UNRELEASED_SESSION` is a `BusinessRuleViolationError` → 422. Details `{ registerId, sessionId }` (opening.ts:107).
- E5 `src/cash-register/infrastructure/cash-adapter-queries.ts:237-241`: `drawerOpen=true` ⇒ `drawerReleasedAt = null`.
- E6 `src/cash-register/infrastructure/cash-adapter-queries.ts:258-288,320`: list scope ALL/OWN/NONE/PER_ROW. OWN adds `cashierUserId = actor`. Visible items carry `cashierDisplayName`.
- E7 `src/cash-register/infrastructure/cash-adapter-list-scope.ts:37-56` and `cash-adapter-instances.ts:75-84`: audit ⇒ all rows, base ⇒ own rows (`isSessionVisible`).
- E8 `src/cash-register/infrastructure/cash-adapter-queries.ts:567-580` and `cash-adapter-storage.ts:162-175`: `cashierDisplayName` = `User.name` through the batched `userNames`.
- E9 `src/cash-register/infrastructure/cash-adapter-recipients.ts:1-20`: exposes `{ userId, displayName, roleName }` of colleagues under a handover-specific grant. Described as a "hint, not a guarantee".
- E10 `prisma/schema.prisma:3371-3376,3422-3451`: `CashSessionStatus` enum. `drawerReleasedAt DateTime?`. Indexes include `[tenantId, registerId, status]`. **Corrected:** the original text said there was no partial or unique index on unreleased drawers. That was wrong. `prisma/migrations/20261007000100_cash_register_closing/migration.sql:111` creates the partial **unique** index `cash_sessions_one_unreleased_per_register` on `("tenantId","registerId") WHERE "drawerReleasedAt" IS NULL`. It is noted at `schema.prisma:3366` and pinned by `prisma/cash-register-schema.spec.ts:411`.
- E11 `src/cash-register/infrastructure/cash-adapter-opening.ts:51-55` and `cash-adapter-storage.ts:36`: open locks the register row `FOR UPDATE`.
- E12 `src/cash-register/infrastructure/cash-adapter-custody.ts:214,259-263`: `releaseDrawer` sets `drawerReleasedAt`, the only release path. `cash-adapter-custody-queries.ts:20-22`: "Opening remains the authoritative check."
- E13 `src/cash-register/infrastructure/cash-adapter-queries.spec.ts:91-130`: current register list tests.
- E14 `src/cash-register/infrastructure/cash-adapter-custody-queries.spec.ts:772`: facade-level `REGISTERS` query.

## Decisions (frontend answers, implemented)

1. No colleague name for an ordinary cashier. `heldBy` uses the same `isSessionVisible` rule as `GET /cash-sessions`.
2. Yes: `drawerHeldStatus` and `drawerHeldSince` are separate from `heldBy` and are present whenever `drawerHeld` is true, for every caller.
3. Yes: inactive registers report the same fields.
4. Indexes: nothing to add. The partial **unique** index already exists (E10, corrected), so the frontend's concern about dev data with two unreleased sessions on one register does not apply. The DB has always rejected that.

## Open questions (original, now resolved above)

1. Product/privacy: should ordinary cashiers see a colleague's name on a held register (frontend's full `heldBy`)? If yes, gate it with a new narrow grant, or accept that `read:CashRegister` implies it. The proposal defaults to no.
2. Should `heldBy.status` and `openedAt` also be shown to non-visible callers (e.g. «En arqueo desde 09:12») without the name?
3. Should a register with `isActive: false` still report `drawerHeld`? Proposal: yes. Opening checks inactive first (opening.ts:83), but a held inactive drawer still needs releasing.
4. Add the optional partial index now, and a partial **unique** index as a DB invariant, or defer both?
