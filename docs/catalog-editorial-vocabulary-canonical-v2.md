# Canonical V2 vocabulary and content revision

`canonicalizeVocabularyV2(unknown)` validates generic consistency, then sorts the detached DTO. `createVocabularyResponseV2(unknown)` calls it once and returns `{contractVersion:2,vocabularyRevision,vocabulary}`. Both are dormant pure APIs; no reader, endpoint or database writer changes.

## Ordering and preservation

Contract proposal [§6](catalog-editorial-production-vocabulary-contract-proposal.md#6-proposed-metadata-dto-and-endpoint-scoped-content-r-b3b4) defines the six-step algorithm. Strings compare by exact UTF-8 bytes, never locale or UTF-16 order. Numeric sort orders compare relationally across the safe-integer range.

- Families: label/code; definitions: code; bindings: sortOrder/definitionCode.
- Options and units: sortOrder/code; null unit codes precede strings only at equal sortOrder.
- Groups: code; aliases: label/optionCode; every group/test optionCodes array: code.
- Only option_cases: cases by code, when tests by definitionCode. Pending and fact_rule branches remain unchanged.

All explicit metadata, nulls, empty arrays and Unicode spelling survive unchanged. Existing closed-shape, uniqueness, reference, policy and static-case guards reject invalid inputs before hashing; inherited errors propagate unchanged.

## Revision boundary

Hash exactly `{contractVersion:2,vocabulary}` through `hashEditorialJson`, then prefix its lowercase SHA-256 with `ev2-sha256-`. The existing serializer owns canonical object keys, string escaping and finite-number spelling. Never hash R itself, envelope extras, headers, facts or DB fields. Permuting sortable arrays preserves output/R; changing explicit metadata changes content identity without Unicode normalization.

S35/S36 removes `minimumContractVersion` from the closed Family DTO and therefore
from the canonical preimage. The serializer is unchanged; nonempty Family vectors
change R, while the empty-vocabulary vector is unchanged. The single-contract
[§§5–6](catalog-editorial-single-contract.md) supersedes the older field/classification.

This is generic representation, not full-production validation (S19). Empty/custom/unbound vocabularies remain valid. R is scoped content identity, not tenant identity, authorization, adoption, publication or activation authority. Coherent snapshots, negotiated transport and runtime consumption remain separate work.
