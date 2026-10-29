# Fresh V2 facts references

`assertFreshFactsReferencesV2(row, family, definitionsById): void` is a dormant,
non-mutating domain gate for T3d S2/S34. Intentional rejection is plain
`Error('MALFORMED')`; success does not authorize publication.

## Caller contract

Supply a parsed `SellableFactsShapeV2`, the selected resolved `FamilyV2`, and
validated definitions indexed by actual opaque IDs. Metadata must be stable,
unique-ID/code, reference-consistent and already admitted for production policy
and minimum contract version. Document references separately establish family
existence, null-family constraints and subject identity. Apply this gate to every
supplied row, not only publication E. Capture gates own bounds/evidence/uniqueness.

## Checked boundary

- Family-key permissions precede unknown dispatch. Unknown skips only value references.
- Known content magnitude resolves its corresponding bound canonical measure;
  `measure.pack_count` never substitutes for content count.
- Axes require finite inventory membership derived from `NUMBERS` and an actual
  ID-resolved, code-agreeing family binding. Accessory capacity is container-only.
- Toy types are exact actual `toy.type` options, including valid extra options;
  aliases/groups do not assign options. Non-toy lists must be empty.
- Optional nonpertinence requires the actual binding's `fact_rule` with exact
  family/parameter and `ruleId: 'optional'`, not `when_asserted` or other routes.
- Custom families get only bound content magnitude and unknown/known-empty optional
  nonpertinence. Minimum version 1 or 2 grants no production-only permissions.
- Any nonnull care review, even unknown, is restricted to care.

No selected-toy-set equality, contradictions, completeness, NA evaluation, care
confirmation, metadata admission, defaults, history/replay validation, HTTP,
storage or activation is implemented. See [facts contract §1–§2](catalog-editorial-production-vocabulary-facts-contract.md).
