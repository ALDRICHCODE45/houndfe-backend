# Fresh editorial document admission V2

`admitFreshDocumentV2(candidate, references, vocabulary, operation)` composes
fresh capture checks and returns a subject-keyed map of qualified facts.
It is an internal dependency, not registered HTTP or complete save authorization.

## Preconditions and order

Inputs are already shape-parsed; references are server-qualified and metadata
is coherent and admitted. The caller must stabilize that observation as needed.

1. Check whole-document references, subjects and uniqueness before building maps.
2. Apply fresh document limits for `save` or `publish`, even without a family.
3. Check every supplied value evidence and numeric assertion by actual definition ID.
4. Qualify every facts row, including inactive subjects, and validate nonnull care captures.
5. Check explicit NA permission using only the exact subject's qualified facts.

The returned map and nested fact values are detached from inputs. Missing facts
remain missing; no known declarations or warnings are fabricated. Helper errors
propagate unchanged. Null evidence and unresolved care may remain saveable.

## Boundaries

Never apply this function to historical reads, receipt replay, initialization
copies or S42 conservation baselines. It does not authorize archived values,
compute E, enforce publication completeness/consistency, confirm care, mint an
attestation, acquire locks, compare R, or persist anything. Passing it is not
proof that save or publication is ready. Existing HTTP/core providers are unchanged.
