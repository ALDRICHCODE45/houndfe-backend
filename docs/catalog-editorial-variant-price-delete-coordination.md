# Variant-price deletion coordination

`ProductsService.removeVariantPrice` joins the ambient transaction without
replacing isolation, or starts one when absent. It locks the tenant-qualified
Product before reading Product, Variant, PriceList or VariantPrice, then deletes
through that transaction client. The response remains void (HTTP 204).

Error precedence remains Product → Variant → PriceList → PUBLICO protection →
VariantPrice. Same-tenant ownership mismatches retain their explicit errors;
foreign-tenant rows are invisible. The PriceList helper accepts an explicit
transaction scope only for deletion; existing upsert defaults remain unchanged.

Callers own any earlier lifecycle/Tenant locks and transaction isolation. Fresh
post-wait observation assumes Read Committed. Cooperating writers must share the
Product gate; this unit does not coordinate all upserts or global-list lifecycle.

Focused tests cover ordering, predicates, errors and synthetic ambient rollback.
The live-spec scenarios describe waiting, unrelated-Product progress, disappearance,
default protection, tier restoration and gate release, but are **not executed**
under this authorization. Mocks are not PostgreSQL proof. This change neither
activates publication nor establishes complete E stability or browser readiness.
