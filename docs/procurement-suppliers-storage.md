# Supplier storage boundary (O3a A1)

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
resulting supplier, including CREATE, and has a tenant-qualified FK.

All new FKs use RESTRICT on delete/update. Tenant identity cannot cascade away and
supplier evidence prevents supplier deletion; cross-tenant audit/receipt references
are rejected. Actor IDs deliberately have no mutable User/membership relation.
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
