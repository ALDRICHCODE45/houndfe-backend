# Fresh explicit-NA admission V2

`assertFreshNAAdmissionV2(values, family, qualifiedFactsBySubject)` is an internal
assertion for fresh explicit `not_applicable` assignments (T3f S35/S45).
It is not registered in any live write or publication path.

## Preconditions

Callers supply stable parsed, unique, reference-admitted values and an admitted
family. Whole-document ownership, subject membership and binding references have
already passed upstream checks. S44 product-target selectors must already be
product-only; this assertion does not repair metadata or aggregate variants.

The `ReadonlyMap<string | null, FactInputsV2>` contains already-qualified facts,
not raw declarations. Capture/evidence/reference qualification stays upstream.

## Permission boundary

Every actual NA assignment resolves its binding and invokes the exclusive policy
dispatcher at that assignment's exact `variantId` (product is `null`, once).
Only `fact_rule` reads the facts map, using that exact subject; a missing row
supplies `{}` as unknown inputs, never sibling or default-product facts.

Admission requires a nonnull result with `applicability: 'not_applicable'` **and**
`allowNA: true`. Missing bindings or denied/unresolved permission throw the existing
plain `MALFORMED` error. Unexpected failures propagate unchanged; inputs are not
modified. S46 optional-equipment O remains applicable and does not permit NA.

Known/unknown assignments are skipped, including known assertions contradicting a
selected NA policy result; publication validation remains separate. All actual NA
assignments are checked without E/inactive filtering. Value evidence, documentary
readiness, completeness and care approval are not gates here. No raw qualification,
baseline eligibility, HTTP/save/publish activation, receipts or replay are added.
