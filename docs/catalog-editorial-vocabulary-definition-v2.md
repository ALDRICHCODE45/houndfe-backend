# Dormant DefinitionV2 admission

`validateDefinitionV2(unknown)` admits one closed metadata definition using the
[§6 DefinitionV2 union](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4).
It exports the union of the existing simple, numeric and choice leaf output types.
No transport or runtime consumer is activated.

## Validation boundary

1. Run `canonicalEditorialJson` before reading `type`; invalid data trees become
   `TypeError('Expected a definition V2')`. Accessors are not invoked.
2. Require a plain object with its own supported string discriminant.
3. Delegate the whole input and return the leaf result unchanged:

| Tags              | Validator                                                 |
| ----------------- | --------------------------------------------------------- |
| `text`, `boolean` | `validateSimpleDefinitionV2`                              |
| `number`, `range` | `validateNumericDefinitionV2`                             |
| `single`, `multi` | `validateChoiceDefinitionV2` (full local alias admission) |

Leaf errors propagate outside the guard's catch, including the unsupported
Unicode runtime `Error`. Returned data is detached; text and array order remain
unchanged. Homonymous option labels remain valid; ambiguous aliases do not.

## Intentionally deferred

Whole-vocabulary uniqueness/references, binding policies, production mapping,
array ordering, revision digest R, assignments, HTTP negotiation and activation
remain separate units. This dispatcher does not establish those contracts.
