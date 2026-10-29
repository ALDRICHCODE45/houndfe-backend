# Check fresh production numeric metadata without rewriting it

`assertProductionNumericDefinitionsV2(family, definitionsById): void` is a dormant, synchronous assertion for explicitly classified fresh production candidates. No consumer, endpoint, database or activation uses it.

## Caller contract

1. Parse the family with `parseFamilyShapeV2`; validate definitions with `validateDefinitionV2`.
2. Establish unique definition IDs/codes, index by actual IDs, then run `assertFamilyReferencesV2`.
3. Keep inputs stable during this assertion. `ReadonlyMap` proves neither provenance nor runtime deep immutability.

The assertion first composes `assertProductionBindingPoliciesV2`; its failures propagate unchanged. Separate custom families retain generic numeric semantics (including pending policies and allowed null units), but cannot borrow production fact rules. A canonical family code is **not permission to adopt existing legacy data**: explicit adoption remains separate. Never call this assertion as a historical read/replay gate.

## Numeric checks

For canonical families only, every binding whose code occurs in the existing 25-row `NUMBERS` catalog resolves by actual definition ID. The resolved code must match; the type must be exactly the mapped number/range even if the received definition is nonnumeric. Only bound definitions are checked.

- Unit codes must equal the mapped set: no missing/extra/null codes, aliases, case folding or conversion. Generic validation already ensures uniqueness; order is unrestricted.
- Policy must be resolved, magnitude equal to the definition code, integer true only for I, lower 0 for P/I and null for F, lowerInclusive false, upper null and upperInclusive false.
- Fit and equipment F domains have no invented positivity; animal mass remains P. Inclusive **value range endpoints** are separate from policy-bound inclusivity; this helper evaluates no values.

Success returns `undefined`; numeric mismatches throw `TypeError`. No labels, IDs, arrays, unit labels or sortOrders change on success or failure. Expected rules are a private projection of the existing catalog, not a second normative table or a domain import from Prisma.

## Review boundary

S2/S4–S8 metadata subset and S14 production/custom separation only. No other-definition/option inventory checks, global seven-family completeness, full vocabulary admission, overlap interpretation, publication eligibility or legacy compatibility/adoption proof. See [mapping §1/§3](catalog-editorial-production-vocabulary-policy-mapping.md) and [wire §7](catalog-editorial-production-vocabulary-contract-proposal.md#7-values-numeric-inventory-and-historical-compatibility-b5).
