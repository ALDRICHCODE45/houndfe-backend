# Materialize a stored V2 vocabulary without inventing metadata

`materializeStoredVocabularyV2(unknown): VocabularyV2` is a dormant structural intermediate. It neither certifies a coherent/full SQL snapshot nor constructs a response. The actual snapshot adapter must establish single-statement MVCC provenance.

## Validation path

1. Guard the entire canonical JSON tree before reading submitted properties, including future storage columns. Accessors and non-JSON values fail without getter execution.
2. Require a root record, `families`/`definitions` arrays and a non-null metadata record with exact `id: 'global'` and `semanticsVersion: 'editorial-production-1'`, even for empty collections. No semantics/defaults are fabricated.
3. Require raw definition records and unit arrays; check string unit IDs globally before dropping them. One empty ID is valid; repeated empty IDs fail. Other choice children retain their definition-local/composite identity rules.
4. Map families through the existing stored-family mapper, single/multi through stored-choice, and other types through stored-scalar (which rejects unsupported types). These unchanged leaves own parent/type, local identity, branch and semantic payload checks.
5. Emit only wire root keys and return the detached output of generic consistency validation, including root uniqueness, references and policy consistency checks. Delegated errors propagate unchanged outside the JSON-guard catch.

Future JSON storage columns are intentionally omitted; semantic policy objects are passed whole, never pruned. Order, strings, versions and resolved metadata are preserved without mutating input. There is no historical graph round-trip that could lose V2 metadata.

## Required next response boundary

**S29 is enforced ONLY by the next historical V2 response unit.** This intermediate permits declared-V1 families with resolved/V2-only metadata; it does not certify declaration truth. The dependent composition must apply conservative legacy compatibility to every family before canonical response construction, rejecting the whole call under S23/S27/S29 rather than promoting, pruning or rewriting data.

No sorting, revision generation, HTTP integration, full-production/seven-family gate, adoption, publication or V2 activation is added here. Existing readers and storage are unchanged.
