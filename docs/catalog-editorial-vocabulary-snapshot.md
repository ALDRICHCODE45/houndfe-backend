# Raw editorial vocabulary observation

`PrismaEditorialVocabularySnapshot.read(): Promise<unknown>` is dormant: no provider, controller or existing reader uses it. One read-only SQL statement observes all vocabulary tables under PostgreSQL statement MVCC, not semantic admission or stability through a later write.

## Preservation boundary

- `metadata` is null when the global row is absent; otherwise its stored id/version survive unchanged.
- Complete rows retain keys, parent relations, raw nullable JSON, timestamps and labels. All child branches are arrays, including empty branches. Bindings additionally carry definitionCode; owners remain product/sellable.
- Existing families, definitions, bindings, units and options use the legacy reader's SQL ordering/collation. Groups use code, members optionCode, aliases label/optionCode. No V2 UTF-8 canonicalization occurs here.
- Whole-row JSON intentionally includes future storage columns. This private observation must never be exposed directly as a closed transport DTO.
- Only result cardinality and root structure are guarded. No policy defaults, version fabrication, owner translation, adoption or strict V2 validation occurs.

## Proof and next obligations

Run the opt-in command from [the harness guide](catalog-editorial-vocabulary-postgres-proof.md), replacing its roots with `src/catalog-editorial/infrastructure` and its test path with `src/catalog-editorial/infrastructure/prisma-editorial-vocabulary-snapshot.integration.spec.ts`. Ordinary execution skips Docker; inline Jest configuration avoids ambient database hooks.

The bridge executes the adapter's captured parameter-free template through `db.sql`, not a second SELECT implementation. Four real migrations and exact expected objects cover empty storage, complete metadata, shared bindings, overlapping groups, archived timestamps, nulls, unknown JSON and resolved metadata invalid for strict V2. Historical blank labels and independently nullable units are simulated only after relaxing constraints inside the owned disposable database; they are not valid-current-migration claims. Cleanup absence is asserted even after test failure. This proves PostgreSQL SQL execution, **not Prisma network decoding**.

Future integration must establish V1 projection's complete/coherent/unique/reference-consistent and historical compatibility preconditions. V2 materialization must explicitly map storage fields, validate the entire response and fail closed on unrepresentable historical metadata (S23); its transport error contract is still unspecified. Neither path gains publication, adoption or write-pinning authority from this observation.
