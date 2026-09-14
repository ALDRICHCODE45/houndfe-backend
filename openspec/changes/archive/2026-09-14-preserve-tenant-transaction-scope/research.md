# Research — Prisma extensions in interactive transactions

## Status

- **Research class:** official documentation/source
- **Result:** complete
- **Proposal ready:** yes
- **Publisher:** Prisma
- **Version boundary:** Prisma ORM 6.19.0 tagged source; the project uses `prisma` 6.19.2 and `@prisma/client` `^6.19.2`
- **Retrieved:** 2026-09-13T15:08:39Z
- **Tool provenance:** parent orchestrator fallback used the approved `fetch_content` tool because the delegated research runtime did not expose it. No search snippets or current v7/v8 documentation are used as Prisma 6 evidence.

## Validated claims

### C1 — Interactive transactions started from an extended client retain extensions

**Status:** validated.

Prisma 6.19.0 creates the interactive transaction callback client from the calling client:

> `result = await callback(this._createItxClient(transaction))`

`_createItxClient` removes the applied proxy, adds transaction-bound promise state, then reapplies model and client extensions:

> `applyModelsAndClientExtensions(createCompositeProxy(unApplyModelsAndClientExtensions(this), [...])))`

The query-extension dispatcher reads the resulting client's extension state and invokes registered callbacks:

> `if (client._extensions.isEmpty()) { return client._executeRequest(params) }`
>
> `const cbs = client._extensions.getAllQueryCallbacks(jsModelName ?? '$none', operation)`
>
> `return iterateAndCallQueryCallbacks(client, params, cbs)`

The official functional suite also creates `xprisma = prisma.$extends(...)`, starts `xprisma.$transaction(async (tx) => ...)`, queries through `tx`, and observes the extension-produced `fullName` result.

**Implication:** `TenantPrismaService.runInTransaction()` must start `$transaction` from `createTenantScopedPrisma(this.prisma, this.cls)`, not from raw `PrismaService`, so the callback client inherits the tenant query extension.

### C2 — `$extends` is intentionally absent from the callback transaction client

**Status:** validated.

Prisma 6.19.0 defines the interactive transaction denylist as:

> `const denylist = ['$connect', '$disconnect', '$on', '$transaction', '$use', '$extends'] as const`

The official ITX extension test asserts that `$transaction` and `$extends` are undefined inside the callback while extension behavior remains available.

**Implication:** testing `'$extends' in tx` cannot determine whether an interactive transaction client already carries extensions. `TenantPrismaService.getClient()` must return the active callback client as-is; extension provenance must be established when the outer transaction starts.

### C3 — The current raw-root transaction is the isolation defect

**Status:** validated by combining Prisma mechanics with local source evidence.

The local service currently calls raw `this.prisma.$transaction(...)`, then stores its callback client in CLS. Because that calling client has no tenant extension, Prisma's `_createItxClient` has no tenant extension state to propagate. Starting from the tenant-extended root is therefore the smallest reusable provenance correction.

### C4 — Local PostgreSQL evidence remains mandatory

**Status:** validated as a project requirement.

The upstream source proves Prisma's extension propagation mechanics, but it does not prove this repository's `createTenantScopedPrisma` rules, CLS storage/restoration, nested reuse, or tenant-specific read/write/create outcomes. The existing PostgreSQL integration harness must demonstrate those behaviors before this change is accepted.

## Sources

| ID | Source | Evidence |
| --- | --- | --- |
| S1 | https://github.com/prisma/prisma/tree/6.19.0 (`packages/client/src/runtime/getPrismaClient.ts`) | `_transactionWithCallback` passes `_createItxClient(transaction)`; `_createItxClient` reapplies extensions to the transaction proxy. |
| S2 | https://raw.githubusercontent.com/prisma/prisma/6.19.0/packages/client/src/runtime/core/extensions/applyQueryExtensions.ts | Non-empty client extension state resolves and executes query callbacks. |
| S3 | https://raw.githubusercontent.com/prisma/prisma/6.19.0/packages/client/src/runtime/core/types/exported/itxClientDenyList.ts | Interactive transaction clients intentionally omit `$extends` and `$transaction`. |
| S4 | https://raw.githubusercontent.com/prisma/prisma/6.19.0/packages/client/tests/functional/extensions/itx.ts | Official functional tests prove extension behavior inside ITX and denylisted method absence. |
| S5 | https://raw.githubusercontent.com/prisma/prisma/6.19.0/packages/client/src/runtime/core/extensions/%24extends.ts | Extended clients append extension state and apply model/client extensions. |
| S6 | https://github.com/prisma/prisma/releases/tag/6.19.0 | Identifies the official Prisma ORM 6.19.0 stable release. |

## Claim-to-source map

- **C1:** S1, S2, S4, S5
- **C2:** S3, S4
- **C3:** S1, S2, S5 plus `src/shared/prisma/tenant-prisma.service.ts`
- **C4:** upstream-source limitation plus `openspec/changes/preserve-tenant-transaction-scope/explore.md`

## Limitations and design guardrails

- Current prisma.io pages redirect to Prisma 7/8 and are not used as evidence for the project's Prisma 6 runtime.
- Query extensions do not automatically constrain raw SQL. Existing raw SQL must remain explicitly tenant-qualified and parameter-bound.
- Direct `getClient().$transaction(...)` consumers do not populate the CLS transaction slot and remain outside this minimal change.
- The implementation must preserve nested transaction reuse and restore the previous CLS client in `finally` on both success and failure.
