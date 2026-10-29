# Dormant choice metadata parsing and admission (C1/C2)

`validateChoiceDefinitionV2(unknown)` admits closed `single`/`multi` metadata with
unambiguous definition-local aliases. It first calls
`parseChoiceDefinitionShapeV2(unknown)`, then checks the alias namespace.
The shape parser alone is **not full admission**: it does not check alias
namespace collisions (S11/S12) or exact duplicate alias labels.
No dispatcher, persistence, HTTP transport or vocabulary activation is added.

## C1 shape contract

- All root, option, group and alias keys are required; extra keys are rejected.
- Identities are nonblank strings. Options require boolean `archived` and
  safe-integer `sortOrder`, including negative values.
- Option/group codes are unique within their respective namespaces. Group members
  are unique within each group and reference exact existing option codes.
- Alias targets reference exact existing option codes, including archived options.
- Empty arrays and overlapping groups are valid. The canonical JSON guard runs
  before submitted properties are read; output is detached without changing
  original strings, array order or input. No sorting, defaults or normalization.

## C2 alias namespace contract

- Reject exact duplicate original alias labels, even for the same target.
- Index comparison key → set of option codes from every option code, option label
  and alias label; reject any alias whose key also names a different target.
  Build the complete index before checking aliases, making verdicts order-independent.
- Preserve homonymous option labels without colliding aliases. Distinct equivalent
  spellings such as `café`/`CAFE` may identify the same target.
- Groups are excluded entirely. Nonblank text with an empty derived key follows
  ordinary collision rules; there is no empty-key ban.
- Use only `editorialAliasComparisonKeyV1`; unsupported Unicode runtime errors
  propagate unchanged, outside the canonical guard's catch. See the
  [comparison and namespace rules](catalog-editorial-alias-comparison-v1.md).

Cross-definition uniqueness, dispatcher integration, ordering/R and activation
remain future scope; neither API validates assignments or expands groups.
