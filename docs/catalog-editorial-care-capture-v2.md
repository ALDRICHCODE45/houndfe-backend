# Fresh care V2 capture bounds

`assertFreshCareCaptureV2(review: CareReviewCaptureV2): void` applies after
`parseCareCaptureShapeV2`. It checks fresh capture only, not historical documents
or receipt replay. Unknown passes unchanged; deliberate rejection is plain
`Error('MALFORMED')`. Inputs, strings and array order are never changed.

Prepared review prose uses Unicode codepoints, rejects lone surrogates and must
be nonblank under ECMAScript trim: jurisdiction 1–200, intendedUse 1–1000,
review/requirement basis and requirement description/warning handlingBasis
1–2000, requirement/warning key 1–80, warning text 1–4000. Nonblank prose may
contain C0/DEL controls and surrounding whitespace.

Requirements and warnings each allow 32 entries with independent exact-key
namespaces. Every evidence array permits 0–16 unique exact sourceRef/verifiedOn
pairs, validated by `isFreshEvidenceV2` (including its stricter source controls
and real Gregorian dates). Pair identity has no delimiter or normalization.
Warning requirementKeys allow 0–32 unique exact references within this review;
33 resolvable references are impossible under the 32-requirement cap.

All supplied reviews need this capture validation regardless of eligibility E.
Empty evidence, identified empty arrays, unresolved/conflicting dispositions,
none_applicable with entries and public_required/unresolved disclosures are
valid capture states here. Passing is **not publication approval**, legal
verification or public-warning approval. Completeness, determination/content
consistency, minimum evidence, disclosure vetoes, E, publisher confirmation and
attestation belong to separate publication gates. No family/metadata lookup,
HTTP/storage integration or activation is added. Existing facts capture still
intentionally excludes care internals.
