# Purchase-order draft commands — O3b T3

`PurchaseOrderCommands` implements create, full replacement and permanent discard of draft intent. It writes only purchase-order headers/lines, command audits and applied-response receipts. Supplier DELETE now rejects tenant-qualified purchase-order references. No stock, reservations, catalog costs, money, CxP or outbox path is invoked. Controller/query/module wiring is T4; PostgreSQL proof is parent-owned T5, not claimed here.

## T4 public API

```ts
new PurchaseOrderCommands(db: TenantPrismaService, cls: ClsService<TenantClsStore>)
createDraft(key: unknown, body: unknown): Promise<PurchaseOrderCommandResult>
replaceDraft(id: unknown, key: unknown, body: unknown): Promise<PurchaseOrderCommandResult>
deleteDraft(id: unknown, key: unknown, body: unknown): Promise<PurchaseOrderDeleteResult>
// PurchaseOrderCommandResult = {statusCode: 201 | 200; body: PurchaseOrder}
// PurchaseOrderDeleteResult = {statusCode: 204; body: null}
```

All exported DTOs/parsers/errors remain in `po-contract.ts`. Register the injectable service in T4's feature module. The HTTP layer must authenticate and populate trusted CLS, admit JSON and exactly one raw Idempotency-Key, reject duplicate raw JSON members, and set no-store. End DELETE responses with zero bytes, not JSON null. The service independently parses bodies/IDs and exact header values for non-HTTP callers; no actor/tenant/permission arguments are accepted.

`requirePurchaseOrderAuthority(tx, {tenantId,actorId}, operation)` supports CREATE/REPLACE/DELETE/READ. It must run after lifecycle and active Tenant SHARE checks, including for readers. `readPurchaseOrderReferences(tx, tenantId, tenantName, order)` returns `{facts,supplierDisplaySnapshot,lineDisplaySnapshots,tenantName}`. The name must come from the caller's current locked Tenant row, never a request. This lock-taking reader requires a caller-owned transaction and the lock order below; it is not an unguarded query endpoint.

## Current authority before replay

| Operation | Persisted grants required |
| --- | --- |
| CREATE | create PO + read supplier + read Product |
| REPLACE | read + update PO + read supplier + read Product |
| DELETE | read + delete PO |
| READ (T4 helper) | read PO only |

PO subject is `ProcurementPurchaseOrder`; supplier subject is `ProcurementSupplier`. Tenant membership and joined role/grant edges are locked, not cached JWT abilities or role names. CASL manage/all implication remains; no global super-admin/editorial bypass or default grants are introduced. Inactive/missing user is 401; inactive/missing tenant or missing membership/grants is 403.

## Transaction and lock order

Each invocation rejects ambient transactions and owns `runInTransaction(..., ReadCommitted)`:

1. Snapshot parsed body, key and authenticated CLS identity before the first await.
2. `lockCatalogLifecycle(tx,'shared')`, then active Tenant FOR SHARE, then active User FOR SHARE and membership/role/role_permission/permission FOR SHARE. Actual grant tuples are held because the permission writer deletes them without locking Role first.
3. Try the transaction advisory gate. Signed first 64 SHA-256 bits of JSON tuple `['procurement-purchase-order-command-v1',tenant,actor,operation,target,exactKey]`; busy is `409 IDEMPOTENCY_KEY_IN_FLIGHT`, without retry or receipt lookup. CREATE target is `collection`; REPLACE/DELETE target is normalized order ID.
4. Receipt lookup uses all five namespace fields, not advisory/body hash alone. Compare canonical parsed-body SHA-256 including CAS. Same namespace/different body is 409 IDEMPOTENCY_KEY_CONFLICT; same body returns detached original status/body. Current references, live order existence and CAS are not consulted on replay, even after discard or supplier archival.
5. Fresh REPLACE/DELETE locks tenant-qualified order FOR UPDATE, then checks expectedVersion and SQL INTEGER ceiling 2147483647. Missing/foreign order is 404; stale/ceiling/lost conditional-write count is 409 ORDER_VERSION_CONFLICT. The last representable event version is allowed; overflow is not.
6. CREATE/REPLACE observes selected supplier FOR UPDATE (same strength as supplier writers), all selected Product rows ordered by id FOR UPDATE, then selected Variant rows ordered by (productId,id) FOR SHARE. Every lookup is tenant-qualified. A same-tenant wrong-parent variant is observed as incompatible; foreign/missing variants are unavailable. No stock fields are read. Missing rows are not invented or gap-locked. DELETE requires no reference reads/permissions/locks.
7. Header/line changes, one audit and one receipt commit atomically. Unknown failures roll back and become value-free INTERNAL_ERROR; no hidden retry. Line replacement removes old lines and writes contiguous request positions. Hard deletion relies on header→line CASCADE, retaining historical audit/receipt IDs.

Supplier DELETE follows its existing lifecycle→Tenant→authority→gate→receipt→supplier UPDATE order. After CAS, it performs a tenant/supplier-qualified existence query **without locking order rows**. Never introduce supplier→order row locks: PO replacement already takes order→supplier, so that would invert the order. The held supplier UPDATE lock serializes new selections with cooperative PO writers; the tenant-qualified RESTRICT FK also protects non-cooperating inserts. Only the named `po_supplier_fk` P2003 signal maps defensively to SUPPLIER_HAS_PURCHASE_ORDERS; unrelated FK failures remain INTERNAL_ERROR. Applied supplier DELETE replay returns 204 before this check. A concurrent discard may conservatively leave DELETE rejected until an explicit new attempt observes its commit.

These locks align with observed catalog writers (lifecycle→Tenant→Product→Variant); exhaustive global deadlock freedom is not claimed. Watcher/index, database execution and existing writers were not changed.

## Admission versus diagnostics

Baseline identities/content are reconstructed from the locked current header and ordered persisted lines, not client buffers or historical receipts. The successful audit for that exact version supplies its saved diagnostics/subtotals for the full before snapshot; missing command provenance fails closed. Because every successful command writes that audit atomically, an ordinary command-produced draft has this provenance.

| Selection | Fresh admission |
| --- | --- |
| null supplier/product, no lines, pending variant, missing quantity/cost fields | Allowed; diagnostic issues only |
| new/changed supplier missing or foreign | 404 NOT_FOUND |
| new/changed supplier ARCHIVED | 409 SUPPLIER_ARCHIVED |
| same persisted supplier ARCHIVED | Allowed with SUPPLIER_ARCHIVED issue |
| new/changed product/variant missing or foreign | 404 NOT_FOUND |
| SERVICE, wrong parent, variant on non-variant product | 400 MALFORMED |
| new/changed reference with cost-unit mismatch or fraction on integer unit | 400 MALFORMED |
| same lineId + same productId + same variantId, now invalid | Retained with current diagnostics and last stored labels |

Completing variantId null→value is changed, even with the same lineId/productId. A new lineId cannot borrow another line's baseline exception. Retained quantity/cost edits still pass T2 syntax/MXN/precision parsing. A changed non-null cost unit requires a current compatible PRODUCT/reference; clearing it to null remains an incomplete declaration. Unchanged cost units are not reinterpreted after catalog unit changes. PRODUCT eligibility does not require useStock=true.

Currently valid observed labels refresh on save; invalidated retained references keep prior names/unit, and absent selections have null labels. Tenant name is refreshed from the locked current branch. `buildPurchaseOrderDiagnostics` supplies stable RFC 6901 issues and exact unrounded line subtotals; there is no order total, tax calculation or implicit cost/tax default. Receipts retain their historical diagnostics and are not live-state reads.

## Durable evidence

CREATE: version 1, 201, SQL-null before audit and full after snapshot. REPLACE: version+1, 200, full before/after snapshots. DELETE: 204 with no wire bytes; its audit event version is previous+1 but before snapshot retains the previous version/timestamps; after snapshot SQL NULL. DELETE receipt response is JSON null (`Prisma.JsonNull`). All other response receipts store full server-built PurchaseOrder JSON. No receipt expiration or evidence update/delete API exists. Rejected admission/CAS/authority writes no baseline, audit or receipt.

## Verification and review

Offline test-first: 40 command assertions failed against the public stub (`Not implemented`); supplier restriction cases then failed with missing 409 mapping. Implementation made the focused suites green, with alternate/new-vs-retained reference, authority, CAS, replay, subtotal and rollback triangulation. Final focused offline validation: 12 suites, 443 tests passed; `git diff --check` passed. No standalone build/lint/typecheck command was run (offline Jest only); the automatic checker reported a previously scanned, unresolved error in out-of-scope `eslint.config.mjs`; it was not rechecked or rewritten. No clean lint result is claimed. Jest mocks prove branch contracts, **not PostgreSQL locking/FK/cascade/rollback behavior**.

`po-commands.integration.spec.ts` is authored but NOT executed by this writer. It covers two-key CAS, original replay after replacement/discard, held advisory gate/manual recovery, authority-before-replay, real RESTRICT rejection/release, concurrent supplier DELETE versus draft CREATE, delete line cascade with retained evidence, zero-effect sampling, and injected audit/receipt rollback using receiver-preserving proxies. Parent must run the guarded integration config only after verifying ownership of a newly disposable database and provisioned schema/client. No existing/shared database, migration, package installation, runtime, commit or push was performed here.

Review first: admission identity triples, non-null unit changes, query tenant predicates/lock ordering, before-snapshot provenance, supplier DELETE replay/CAS precedence, and integration proxy receivers. T4 still owns HTTP/query integration; T5 owns actual SQL evidence and runtime readiness.
