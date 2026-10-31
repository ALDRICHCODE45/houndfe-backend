# Archived option conservation V2

`conserveArchivedOptionsV2(candidate, baselineInput, references, vocabulary)`
returns fresh `ArchivedOptionWarning[]` or throws plain `Error('MALFORMED')`
for an unauthorized archived assertion. Unexpected dependency errors propagate.

## Preconditions

The candidate is parsed and reference-admitted against the same coherent,
admitted vocabulary and qualified tenant/product references. Inputs and identities
remain stable during the call; identities must not be reused. Fresh admission,
NA permission and publication readiness remain separate obligations.

The caller supplies the authoritative whole stored baseline: Draft for save,
current Published for publish. This helper cannot prove stored provenance.
It qualifies the whole baseline through `eligibleConservationBaselineV2` before
looking up any assignment. No eligible baseline means no conservation grants.

## Matching and output

Only known single/multi payloads introduce options. Match family, definition code,
owner, variant and known payload type. Single requires the same prior option;
multi requires each archived member to have existed in that same assignment.
Reorder, removal and active additions are allowed; moved, new or re-added archived
options are not. No historical search or candidate fallback grants permission.

Warnings contain exactly code, actual family/definition IDs, owner, variantId and
optionCode, in candidate value/option order. No retained archived options returns
`[]`; fresh response omission belongs to the state composer. Inputs are unchanged.

Never rebuild GET history or recorded replay warnings with this generator.
Initialization copies and runtime writer registration are unchanged.
