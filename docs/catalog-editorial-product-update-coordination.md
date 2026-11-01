# Complete Product PATCH coordination

`ProductsService.update` keeps request-only allowlist validation and lowercase
normalization before database access. It then enters or joins the existing tenant
transaction and acquires lifecycle SHARE, selected Tenant SHARE, and a
tenant-qualified Product UPDATE lock, in that order. Missing gate rows use the
existing Product-not-found error rather than permitting an unqualified read.

The private operation body runs only after those gates. Product/binding reads,
merged stock validation, type/uniqueness/SAT checks, default-list lookup, all
existing writes, and the complete enriched response share the ambient client.
The existing persistence-tail and repository transaction calls join the outer
transaction; they are not extra physical transactions or premature commits.
An existing ambient caller retains ownership, isolation and final commit/rollback.
Callers must enter this operation before acquiring conflicting later-order locks;
there is no lock-upgrade, retry or shared-factory rewrite here. Fresh post-wait
observations rely on Read Committed, as in the cooperating writer contract.

## Preserved behavior

- Omitted or explicitly undefined allowlist retains stored IDs, including stale
  IDs. Explicit `[]` means all public contexts. Only supplied nonempty replacements
  are validated against the fresh tenant bindings; malformed input still fails
  before opening a transaction.
- Merged stock settings, type/lot protection, SKU/barcode normalization and
  uniqueness, SAT validate-on-change, zero default prices, variant membership,
  stock cascade, rearm gating and ServiceDetail ordering retain their semantics.
- Name-only PATCH also takes the gates: repository save persists the entire
  aggregate and replaces its allowlist, so omitted fields require a fresh load.
- Response read/enrichment failures now roll back the mutation rather than
  rejecting after it has committed. Ordinary GET and enrichment helpers remain
  unchanged. The response describes transaction-local state; under an ambient
  caller it does not claim that the caller has committed.

## Verification boundaries

The composed offline suite uses the real repository, domain and response helpers
with instrumented transactional stores. Existing business assertions remain;
fixtures distinguish logical joins from physical transactions. Mock rollback is
not PostgreSQL proof. Seven additional PostgreSQL schedules are authored in
`products-variant-coordination.live.spec.ts`: three gate waits, response success/
failure, and outer commit/rollback with unrelated-product progress. They remain
**unexecuted**. Their non-stock PATCH scenarios do not prove live stock-alert rearm.

No Product deletion, permission/controller change, shared transaction factory,
service activation, complete union-E reader, publication integration or public
C3.3 implementation is included in this unit.
