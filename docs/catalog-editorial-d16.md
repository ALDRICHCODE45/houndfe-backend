# Contextual D16 validation — internal and unactivated

`validateContextualDocument` in `domain/contextual-document.ts` composes the
unchanged strict `validateDocument` with archived-option conservation. Inputs are
an unknown candidate, current qualified reference authority (tenant/Product,
variants and private asset IDs), an `EditorialDefinitionsSnapshot`, and a trusted
baseline document or null. It returns a detached document and typed warnings.

The baseline is an internal trust boundary: this pure function cannot establish
persisted provenance, authorization, freshness, CAS or locking. Integration must
obtain it from the authorized locked Draft, Published or matched successful receipt,
never from the request. Existing core consumers are not connected in E1.

Archived options are retained only in the same family/definition/owner/variant
assignment already present in the baseline. Stable, non-reused codes resolve to
current persisted identities. New, reintroduced and moved archived assignments
fail with `MALFORMED`; labels are not option codes. Multi-selection preservation
uses per-option membership: reorder/removal/active replacement remain valid.
Missing current definitions/options and revoked variant/media references still
fail. No conservation policy is inferred for archived families, definitions or media.

Each retained archived assignment yields `ArchivedOptionWarning`:
`{ code: 'ARCHIVED_OPTION', familyId, definitionId, owner, variantId, optionCode }`.
Warnings follow candidate value/option order. Removing or replacing the archived
assignment removes its warning. Incomplete documents remain valid capture data.
The temporary all-code projection is private to strict validation and never
returned as an assignment allowlist; contextual checks must succeed first.

## Verification and boundaries

```sh
pnpm exec jest --config jest.config.js --runInBand --runTestsByPath src/catalog-editorial/domain/contextual-document.spec.ts src/catalog-editorial/domain/document.spec.ts
```

E1 tests are pure/synthetic; they do not prove stored baseline provenance or
concurrency. E2 adds transaction-bound integration and deterministic two-connection
proof. E3 adds explicit Published/empty initialization without reinterpreting
`create(document)`. No schema, vocabulary load, media provider, route, UI,
publication or runtime registration is added here. The real private-media authority
remains an independent gate; no empty asset list is a substitute.

Rollback boundary for E1: remove only the new contextual validator, its tests and
this document; the original validator and consumers are unchanged.
