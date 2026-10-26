# Catalog editorial core — unactivated

This is a callable internal contract, **not a deployable API**. No route,
controller, module registration, permission subject or effective grant exists.
Integration and C3.1 remain pending.

## Closed document validation (first review slice)

`domain/document.ts` defines nullable `commercialTitle`, `description` and
`familyCode`, ordered private asset IDs, and explicit product/sellable values.
The five value types are text, boolean, finite number with an accepted unit
(including explicit null only when allowed), single code and multiple codes.
Unknown keys, unknown definitions, wrong ownership, types, codes, units and
references fail with `MALFORMED`. Duplicate bindings and references are rejected.
Missing attribute values are allowed: this is not publish completeness checking.

`validateDocument` needs a tenant/product-qualified authoritative snapshot;
there are no runtime fixture definitions. The future core must check that
snapshot's qualification, current membership/capability and Product access
before reads, writes **and receipt replay**. The validator alone is not an
access-control boundary. Definitions, private media and permission authority
integrations are still missing; existing public upload paths are not assets.

Validation never reads or changes `Product.name`, POS data or public catalog
consumers. `emptyDocument()` starts incomplete with no copied operational name.

Focused check (no database or environment loading):

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath src/catalog-editorial/domain/document.spec.ts
```

Read/create/save persistence, durable anti-ABA cycle, revision CAS and atomic
idempotency receipts are not implemented by this first slice. Published data
must remain nullable and untouched by that future core. Receipts must be retained
without expiry or cleanup in this unactivated unit; transport and retention
integration remain pending (no approved 24-hour policy).

Rollback boundary: remove the isolated domain contract, its colocated test and
this document. No existing consumers or shared behavior have been changed.
