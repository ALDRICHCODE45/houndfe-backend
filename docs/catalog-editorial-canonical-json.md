# Canonical editorial bytes — dormant prerequisite

`canonicalEditorialJson(value)` returns fresh canonical UTF-8 `Buffer` bytes;
`hashEditorialJson(value)` returns their 64-character lowercase SHA-256 hex digest.
These generic helpers have no runtime consumers yet. They do **not** validate a
vocabulary, authorize publication or enable contract version 2.

## Serialization contract

The implementation follows [wire §6, steps 4–6](catalog-editorial-production-vocabulary-contract-proposal.md):

- Object keys sort by UTF-8 bytes, including numeric-looking keys. Arrays retain order.
- Strings retain Unicode scalars without normalization. Quote/backslash are escaped;
  all C0 characters use lowercase `\u00xx`. Slashes remain literal.
- Finite numbers use ECMAScript JSON spelling (`-0` becomes `0`); nulls and empty
  arrays/objects remain explicit. No whitespace, BOM or trailing newline is added.
- Accept plain data objects (including null-prototype objects) and dense arrays.
  Reject lone surrogates, undefined, nonfinite numbers, non-JSON primitives,
  cycles, class instances, accessors, hidden/symbol properties and decorated arrays
  rather than silently discarding them. Repeated non-cyclic references are valid.
- Rejected input throws `TypeError('Expected a finite, acyclic JSON data tree')`.
  Neither helper mutates its input or caches output.

## Consumer obligations — not implemented here

| Consumer            | Required work before hashing                                                                                                                                            | Prefix applied by consumer |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Vocabulary revision | Validate the complete closed DTO, identities/references and policy; canonicalize vocabulary-specific arrays; build exactly `{contractVersion:2,vocabulary}`             | `ev2-sha256-`              |
| Care confirmation   | Validate the complete captured document and locked revision; build exactly `{cycle,draftRevision,document}`; preserve all document array order, including inactive rows | `ecd2-sha256-`             |

Generic serialization cannot reject extra DTO keys or decide applicability, exposure,
legacy defaults, eligibility or completeness. Consumers must not hash raw database
rows. The helpers add neither a domain prefix nor a preimage wrapper automatically.
The existing provisioning planner's private serializer serves plan ordering only;
it is unchanged and must not be substituted for wire serialization.

## Verification

```sh
pnpm test:unit --runInBand --runTestsByPath src/catalog-editorial/domain/editorial-canonical-json.spec.ts
```

Tests pin exact bytes, three literal SHA-256 vectors independently checked using
Python `hashlib`, UTF-8 versus UTF-16 key ordering, all C0 escapes, scalar rejection,
array-order sensitivity and input/output isolation. Endpoint negotiation, coherent
SQL snapshots, closed DTO validation and production provisioning remain separate work.
