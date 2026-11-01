# Variant-price deletion coordination

`ProductsService.removeVariantPrice` joins the ambient transaction without
replacing isolation, or starts one when absent. It acquires lifecycle SHARE before
the tenant-qualified Product lock and all Product/Variant/PriceList/VariantPrice
reads, then deletes through that transaction client. Response stays void (HTTP 204).

Error precedence remains Product → Variant → PriceList → PUBLICO protection →
VariantPrice. Same-tenant ownership mismatches retain their explicit errors;
foreign-tenant rows are invisible. The PriceList helper accepts an explicit
transaction scope here; existing single/bulk upserts retain their own coordination.

Lifecycle precedes any caller-owned Tenant/Product/child locks. Ambient callers
with earlier row locks must already own lifecycle; transactions also deleting a
global list must choose exclusive upfront, never upgrade shared to exclusive.
Both gates remain held through the void result until outer transaction completion.
Repeated shared acquisition is not an upgrade. No arbitrary ambient lock inspection
or isolation override is introduced; fresh post-wait reads assume Read Committed.

The shared relation gate conflicts with actual global deletion and other global
list DML, not ordinary SELECT. Existing privileges must permit SHARE; no grants
are added. Only this endpoint joins the protocol here; other upserts and broader
writers remain separate. Global deletion retains cross-tenant cascade semantics.

Focused tests cover ordering, predicates, errors and synthetic ambient rollback.
The live-spec scenarios describe waiting, unrelated-Product progress, disappearance,
default protection, tier restoration and gate release, but are **not executed**
under this authorization. Additional authored schedules pair actual global
removal commit/rollback with fresh endpoint results, and endpoint-first deletion
with shared progress, queued exclusive waits, repeated ambient calls and outer
commit/rollback. PID/pg_locks mode witnesses and finally drains are required;
price and tier effects are asserted. Mocks are not PostgreSQL proof. This change
neither activates publication nor establishes complete E stability or browser readiness.
