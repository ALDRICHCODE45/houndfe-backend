# Pure production choice inventory

`src/catalog-editorial/domain/editorial-production-choice-inventory.ts` owns the
compact choice defaults formerly private to the Prisma manifest. Import it for
read-only canonical rows, not for vocabulary admission or mutation authority.

## Ownership and shape

| Export      | Shape                                     | Contents                                                 |
| ----------- | ----------------------------------------- | -------------------------------------------------------- |
| `INVENTORY` | `[ChoiceCode, groupCode, caption, pairs]` | 67 normalized groups, 514 options across 32 choices      |
| `OVERLAY`   | `[optionCode, label]`                     | Three separately approved S7 hygiene presentations       |
| `ALIASES`   | `[label, optionCode]`                     | Eight approved animal aliases targeting existing options |

Every tuple contains only primitive strings. Both outer arrays and inner tuples
are frozen at runtime and readonly in TypeScript. Literal values and row order
are preserved; `ChoiceCode` comes from the existing pure production catalog,
without another choice-membership list. Groups are not options.

## Unchanged construction boundary

`prisma/editorial-production-vocabulary.manifest.ts` imports these rows and still
owns expansion, public types, provenance and `buildProductionVocabularyManifest`.
The builder returns fresh mutable nested objects, including overlay provenance;
freezing the compact source does not freeze caller-owned output. Domain imports
do not depend on Prisma at runtime.

Review the inventory spec for shape, counts and two-level immutability, then the
unchanged documentary manifest oracle for exact labels, source order, provenance
and fresh outputs. The unchanged planner tests protect customization preservation.

## Not admission or activation

This extraction adds no completeness assertion, normalization/alias reconciliation,
legacy adoption, custom-rule overlap checks or automatic compatibility inference.
S14 exact production families and S15 validated extras remain separate admission
work; these defaults do not prohibit extra valid identities or memberships. No
DB execution, assignment, publication, transport activation or HTTP behavior changes.
