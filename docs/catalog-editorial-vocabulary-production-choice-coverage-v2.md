# Production choice coverage V2 (dormant assertion)

`assertProductionChoiceCoverageV2(family, definitionsById): void` composes
`assertProductionNonnumericDefinitionTypesV2`, including its production-binding
policy check. Success adds only canonical choice option/group/membership coverage
for definitions bound to the supplied canonical family; it returns no projection.

## Trusted preconditions

The caller supplies a parsed `FamilyV2`, fully validated `DefinitionV2` objects,
unique definition IDs/codes, a map keyed by each definition's **actual ID**, and
already-checked family references. Inputs must remain stable during the call.
Use the existing public shape/definition/reference validators first. In particular,
valid extras and alias-collision rules are trusted to `validateChoiceDefinitionV2`
(via `validateDefinitionV2`), not reimplemented by this assertion.

## Coverage and preservation

- S2/S14: only canonical choices bound to a canonical production family are checked;
  binding IDs resolve definitions, never code-as-ID lookup. Custom families retain
  generic semantics; unbound canonical definitions are not inspected.
- Required identities derive from shared domain `INVENTORY`: split pairs on `; `,
  take the key before the first `=`, and prefix it with the row's group plus `.`.
  Every row's group and all its required option memberships must remain present.
- S7: shared `OVERLAY` options are required in the **first inventory hygiene.form
  group**, matching the existing expansion, not the submitted group-array order.
- S15: validated extra options/groups/memberships (including overlapping groups)
  are allowed. Archived required options count as present. Labels, order, archives,
  aliases and custom values are untouched; success and rejection do not mutate inputs.

This is not full inventory/vocabulary admission, alias coverage, numeric-domain
validation, legacy compatibility/adoption authority, provisioning, assignment or
publication validation. Approved-alias coverage is a separate future unit; valid
missing aliases are deliberately accepted here. No runtime consumer, API activation,
DB execution, automatic assignment or compatibility inference is introduced.
