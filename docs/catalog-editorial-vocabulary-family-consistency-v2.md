# Family V2 required-case metadata consistency

`assertFamilyPolicyConsistencyV2(family: FamilyV2): void` synchronously checks two
metadata invariants on **every** option case in every binding:

| When                | Required metadata                                      |
| ------------------- | ------------------------------------------------------ |
| `required === true` | `applicability === 'applicable'`                       |
| `required === true` | Containing binding has `publicationCheck === 'always'` |

An inconsistent case throws `TypeError('Inconsistent family policy V2')`.
Success returns `undefined`; there is no admitted output or mutation. Input must
come from `parseFamilyShapeV2` and remain unchanged throughout the assertion.
This trusted-input helper does not parse, copy, select cases or read actual values.
Nonempty `when` and array order cannot hide a potentially required case.

## Preserved distinctions

- Applicable does not imply required. Optional cases may use either publication
  check, with any applicability state.
- `allowNA: true` is preserved even with applicable/unresolved metadata. This does
  **not** admit runtime NA: that still requires a resolved selected result with
  `applicability === 'not_applicable' && allowNA === true` (contract §6 / FE seq5).
- Documentary readiness and evidence flags are independent; no equality or
  requiredness is inferred from them.
- Empty families/case arrays, pending policies and fact rules pass this check.
  Fact rules are neither evaluated nor checked against production triples here.
- Conditional intermediate selectors are not rejected or made unconditional.

## Boundary and review

This dormant T3c S2,S4–S8 metadata subset implements only the two implications
above from [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).
It does not check references, cycles, satisfiability, overlap, production mapping
or legacy compatibility, establish full vocabulary admission, or authorize
publication. There is no runtime consumer, transport or activation change.
Review the required/applicability/publication table first, then the later-case,
order-reversal, frozen-input and preservation tests in the sibling domain spec.
