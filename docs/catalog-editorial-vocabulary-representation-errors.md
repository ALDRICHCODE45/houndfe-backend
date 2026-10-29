# V2 representation rejection boundary

`EditorialVocabularyRepresentationError extends TypeError` identifies deliberate
validation rejection in the dormant V2 read chain. Each site retains its exact
message, `name: TypeError` and TypeError ancestry.

## Covered boundary

The converted modules are stored-root/choice/scalar/family, simple, numeric,
choice, definition, shape, family-shape, policy-shape, family-references,
family-consistency and option-case-static (all
`editorial-vocabulary-*-v2.ts`). Composition inherits their errors unchanged.
Production-only assertion helpers are intentionally not blanket converted.

The eleven canonical guards translate only `CanonicalEditorialJsonError`.
Unexpected serializer failures now escape unchanged rather than being swallowed
as validation errors, including same-message TypeErrors and non-Error values.
Delegates remain outside guard catches; parsing rules and order are unchanged.

## Future translation only

This class prepares precise S23/S27 whole-response failure classification; it
adds no HTTP mapping, reader wiring, V1 changes, activation or storage rewrites.
Future transport may map this class to the approved HTTP 500
`EDITORIAL_VOCABULARY_UNREPRESENTABLE`, never blanket-map arbitrary TypeErrors.
S35/S36 supersedes and removes S29 declared-V1 compatibility rejection; generic
shape/reference/policy/static checks and unexpected-error identity remain.
