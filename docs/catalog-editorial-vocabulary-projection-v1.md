# Whole-family V1 vocabulary projection

`projectVocabularyV1(snapshot)` is a dormant pure projection implementing [contract §3](catalog-editorial-production-vocabulary-contract-proposal.md#3-exact-proposed-headers-and-admission-order) for T3c S2/S18/S19. It returns only the existing V1 DTO, without an envelope, version or revision.

## Required caller guarantees

The snapshot must be complete, coherent, unique by identity, reference-consistent, stable throughout the call and already in reader order. Retained version-1 families must already have legacy-compatible definitions and bindings, with no advanced policies. A future loader/admission boundary must establish these guarantees; TypeScript types prove neither these preconditions nor database coherence.

Contradictory declarations are not repaired, pruned or promoted. A retained range throws a precondition error because V1 cannot represent it; this narrow guard is not a compatibility validator. Historical values never pass through strict V2 parsers, S18 candidate admission or the S19 full-production validator here.

## Binding membership helper

`indexVocabularyV1Bindings(families)` extracts only the original membership scan. It returns fresh, independent `ReadonlySet<string>` views: `originallyBound` includes bindings from every family, while `retained` includes bindings from version-1 families only. IDs, including blanks, are used exactly; shared IDs collapse by set membership.

Supply the complete original family/binding graph, not an already-filtered graph, stable throughout the call. The helper does not establish reference consistency or any of the [caller guarantees](#required-caller-guarantees) above. It neither filters definitions nor classifies numeric metadata, validates leaves, admits candidates or converts historical graphs into trusted snapshots. The sets are detached from input and later calls; `ReadonlySet` is a TypeScript interface, not a runtime freezing guarantee.

The projector composes this helper before its existing family/definition selection and explicit field copying. Historical V1 composition remains a separate unit.

## Preservation and selection

All original binding IDs are recorded before filtering. Whole version-1 families retain every binding; their referenced definitions appear once in original definition order, including shared definitions. Definitions bound only to omitted families are excluded, even text. Genuinely originally-unbound definitions retain the five legacy types, excluding ranges and resolved numbers; absent/null/pending persisted numeric policies retain numbers. The nullable JSONB status shape follows `schema.prisma` and migration `20261028120000_editorial_production_metadata`, without invented defaults or numeric-domain validation.

Binding owners remain the persisted `product | sellable` values, exactly as the existing SQL reader emits them; no uppercase owner translation is performed.

Explicit field copies strip other metadata and deeply detach every output object/array. Labels (including blanks), independently nullable unit codes/labels, empty arrays, option archives, owners, sortOrder and array order remain exact: no sorting, trimming or normalization. No reader, SQL, HTTP, database, adoption, publication or V2 activation changes are included; historical admission and coherent-loader integration remain separate proof obligations.
