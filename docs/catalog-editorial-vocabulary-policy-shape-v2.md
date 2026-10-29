# Binding policy V2 shape boundary

`parseBindingPolicyShapeV2(unknown)` is a dormant metadata parser, **not full admission**.
It exports `BindingPolicy`, `FactRule`, `PolicyCase` and `OptionTest` from the domain module.
The normative shape is [contract §6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).

## Accepted shape

- `pending` has only `route`; `option_cases` adds required `cases`; `fact_rule` adds required `rule`.
- Every record is closed and every field required. Booleans are literal booleans; identifiers are nonblank strings, preserved without trimming or coercion.
- Case codes are unique per policy; tested definition codes unique per `when`. Expected option codes are nonempty and unique exact strings.
- Empty `cases` and empty `when` are allowed; empty `when` denotes an unconditional case. No matching or evaluation occurs here.
- Fact rules check exact global family/rule/parameter membership through the domain catalog, not production triples or containing binding identity.
- The canonical data-tree guard runs before submitted-property access; malformed input throws `TypeError('Expected a binding policy shape V2')`.
- Output records and arrays are detached, preserving order and spelling; frozen inputs are accepted. No sorting, defaults or mutation occurs.

## Deliberately deferred

Same-family references, choice/option membership, selector cycles, overlap/contradiction solving, contextual result consistency and production triple admission are not checked.
Neither actual rule evaluation, publication permission/evidence, nor care-review compliance is implemented.
This S2,S4–S8 metadata subset does not activate dispatch, HTTP transport, storage, ordering/digest R, public exposure or vocabulary admission. A parsed shape alone grants no publication permission.
