# Supplier storage boundary (O3a A1, D1 deletion)

## D1 forward deletion change — SQL execution pending

S5/S6 explicitly authorize relaxing the two live-supplier FKs, superseding A1's deletion prohibition below. The old additive migration is unchanged. New forward migrations are split: `20261103010000_supplier_delete_operation` adds the DELETE enum value; `20261103010100_supplier_delete_evidence` uses it only after the enum migration commits. The second migration drops only `supplier_audit_supplier_fk` and `supplier_receipt_supplier_fk`, replacing the receipt namespace/status CHECKs with CREATE/UPDATE's unchanged branches plus DELETE (`target=supplierId`, status204, JSON null response). No existing data is rewritten or removed.

All tenant FKs remain restrictive; positive versions, audit version uniqueness, receipt namespace primary key, key/hash checks and old snapshots remain intact. Historical `supplierId` is now intentionally a scalar, not a live supplier relation. Consequently raw SQL no longer checks whether an audit/receipt scalar supplierId currently exists or belongs to that tenant. Feature commands establish provenance with authenticated tenant-qualified writes/locks, never caller-provided evidence writes. SQL is not RLS or tamperproof auditing.

Deletion removes only `ProcurementSupplier`. CREATE/UPDATE audit snapshots retain their original wire shape. A DELETE audit snapshot uses that same shape with **prior** id/displayName/termsText/status/createdAt/updatedAt and **deletion event version** `previous+1`. The retained prior `updatedAt` is not a claimed deletion time: audit `createdAt` is the event timestamp, `actorId` the historical actor, and `operation=DELETE` distinguishes removal from a live row update. Receipt `responseBody` is JSON null (`Prisma.JsonNull`, never SQL NULL), while the HTTP response has no bytes. No evidence expiry/update/delete API is added.

There is no purchase-order table, eligibility query or reference-coverage proof. `409 SUPPLIER_HAS_PURCHASE_ORDERS` remains reserved for O3b. Before orders exist, O3b must introduce a tenant-qualified restrictive order→supplier FK and deliberate eligibility/error mapping, so history retention does not become permission to orphan orders.

D1 SQL specs are **authored, not executed by the writer**. They now expect live-row deletion to retain all prior audit/receipt values and scalar IDs, reject missing evidence tenants even after relaxing the supplier FKs, and prevent tenant deletion after removing its live supplier. DELETE namespace/status/null negative cases supplement all prior name/terms/version/key/hash checks. Parent D2 must apply forward migrations to its newly owned disposable target, verify pre-existing evidence across migration, and execute the SQL suite; no existing database/migration execution is authorized here.

## A1 historical evidence (before the D1 extension)

**Storage unit verified.** Parent disposable migration and SQL checks passed
(9 offline tests and 18 PostgreSQL tests). Independent A1 review found no blockers:
9 offline tests and schema validation passed; the parent SQL log was reviewed, not rerun.
Broad regression and API behavior are not established by this storage-only result. No API, service, permissions, role grants or history endpoint is
provided by this unit. No purchase orders, stock, payments, CxP, or outbox effects.

## Three records, one future transaction

- `ProcurementSupplier`: tenant-owned UUID identity, display name, nullable documentary
  terms, explicit ACTIVE/ARCHIVED status, positive version starting at 1, timestamps.
  Names need not be unique. Tenant-first descending `(createdAt,id)` indexes support
  status-filtered and ALL pagination; contains/insensitive search is not a B-tree seek.
- `ProcurementSupplierAudit`: durable actor, command, resulting version, timestamp and
  JSON snapshot. One record per tenant/supplier/version. Actors are historical scalar
  IDs (no User FK), so account removal cannot erase or rewrite historical identity.
- `ProcurementSupplierReceipt`: applied result only, lowercase SHA-256 request hash,
  original HTTP status and JSON response body independent of current supplier state.
  JSON preserves wire values, not original JSON whitespace/property serialization.

Receipt primary key is **tenant + actor + operation + target + exact key**. CREATE
uses literal `collection` (not the generated supplier ID); UPDATE uses supplier ID.
Archive/reactivate are UPDATE/PATCH with status changes, not separate commands.
The same key can be used by another actor/tenant/target/operation without replaying
someone else's response. Keys retain whitespace; SQL limits them to 1–200 codepoints.
CREATE receipts require 201; UPDATE requires 200. `supplierId` always identifies the
resulting supplier, including CREATE, and originally had a tenant-qualified live-supplier FK (removed by D1 above).

A1 originally used RESTRICT on all FKs and prevented supplier deletion. D1 removes only the two live-supplier FKs; tenant identity still cannot cascade away. Historical scalar supplier IDs are retained rather than joined to live suppliers. Actor IDs deliberately have no mutable User/membership relation.
These tables are registered individually in `TENANT_SCOPED_MODELS`; tenant injection
is application defense, **not PostgreSQL RLS**. Direct/raw clients must qualify tenant.

SQL checks enforce positive versions, Unicode-codepoint name/terms bounds, nonblank
name (ECMAScript trim whitespace set), key bounds, hash format and operation-specific
namespace/status. Enum types enforce status/operation vocabulary. UUID generation and
`updatedAt` maintenance follow existing Prisma conventions, not SQL defaults/triggers.
SQL does **not** enforce CAS, version increments, snapshot shape, canonical hashing,
authority, or one audit/receipt per successful write. A2 must validate these and commit
supplier + version + audit + receipt atomically; failed commands must leave none.
Audits/receipts will be immutable through the feature API (no update/delete endpoint),
not SQL-tamperproof against privileged database writers. No expiry/cleanup is added.

## Evidence and remaining parent proof

Offline `supplier-storage.spec.ts` checks drift and actual tenant-extension argument
injection without PostgreSQL, plus no-emit typechecking of the integration spec
against the isolated generated client. It is not SQL execution or authorization proof.
`supplier-storage.integration.spec.ts` uses the existing integration config/global
setup and guarded target helper, with transaction-rollback fixtures, no business seed
or cleanup deletes. It covers namespace reuse/collision, original-response retention,
Unicode boundaries, invalid writes, composite tenant FKs and deletion restrictions.

**Not executed by the writer.** Parent job-6 verified the newly owned PostgreSQL17
container, internal network, tmpfs storage, absence of env overrides and exact target
before integration Jest. Global setup applied all migrations, including this additive
migration, only to that disposable database; all 18 SQL tests passed. Offline test-first
observed 5 failures before implementation, then 9 passing tests; no runtime RED is claimed.
Existing named-volume databases and root API3000 were untouched. These test-target guards
alone do not prove ownership; repeat the identity preflight for later executions. A2/A4 must separately
prove authority-before-replay, canonical-body conflict handling, CAS/concurrency,
atomic business rollback and zero stock/money effects.

Rollback boundary: remove only this migration, these three schema models/two enums,
their Tenant back-relations/registry entries, the two specs and this document before
any deployment. Applied disposable databases remain parent-owned; no down migration
or destructive operational rollback is supplied.
