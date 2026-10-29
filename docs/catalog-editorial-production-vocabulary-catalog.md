# Production vocabulary ownership

The pure domain catalog owns the seven families, 68 definition rows and 12 rule IDs.
Its exported tables and their primitive-only tuples are frozen at runtime and readonly in TypeScript.
Private membership sets are derived from those tables; no mutable authority is exported.

`isProductionDefinitionCode`, `isProductionFamily` and `isProductionRuleId` accept unknown inputs and narrow only exact strings, without trimming, case folding or prefix matching.
Membership does **not** establish allowed family/rule/parameter triples or binding correspondence; policy parsing and admission remain separate future work.

The Prisma manifest imports the catalog and re-exports its existing public types.
It still owns option inventory, provenance, construction and binding expansion, returning fresh mutable objects as before.
There is no domain-to-Prisma runtime dependency, database operation, transport activation or public exposure change.
