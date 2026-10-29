# Stored scalar V2 boundary

`materializeStoredScalarDefinitionV2(unknown)` is a dormant raw-row mapper for text, boolean, number and range. It is not a snapshot reader or transport endpoint.

## Contract

- Guard the entire JSON tree before property reads, including future storage columns.
- Require units/options/groups/aliases arrays; options/groups/aliases must be empty. Simple definitions also require empty units and explicit null numericPolicy.
- Numeric units require own string storage IDs, locally unique, and exact definitionId/definitionType parents. Empty storage IDs are preserved as historical identity, not exposed on the wire.
- Explicitly copy wire fields; map unitCode to code without trimming, sorting, deduplication or normalization. Future storage columns are ignored, not semantic policy keys.
- Pass numericPolicy whole and unchanged to the existing numeric validator. Missing/SQL-null/malformed/extra-key policies fail; never fabricate pending, bounds or magnitude.
- Existing simple/numeric validators own wire identity, units, safe orders and domain rules. Their errors propagate by identity. Output is detached and preserves representable strings, nulls and order.

## Remaining obligations

S2 adds only this leaf prerequisite. Under S23, future V2 composition must fail the whole response for unrepresentable metadata. S27's HTTP 500 `EDITORIAL_VOCABULARY_UNREPRESENTABLE` translation remains future transport work; this helper does not implement it.

A future root must enforce storage unit ID uniqueness across definitions and establish complete/coherent snapshot provenance. This leaf checks local IDs only. No full-production admission, adoption, publication, V1 reader change or activation is authorized here.
