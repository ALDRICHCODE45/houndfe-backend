# Recognize historical legacy documents without fresh validation

`isRecognizableLegacyDocument(unknown)` is a dormant structural type guard for
contract §5 adoption preparation. It returns a boolean, never a converted or
normalized document. It does not grant permission or authorize adoption.

## Recognition boundary

- Require the closed five-key root and all five closed legacy payload branches.
- Require unique string media/multi entries and unique `[code, variantId]` tuples,
  finite numbers, empty values for null family, and null variant for product owner.
- Inspect own enumerable data descriptors; reject accessors without executing
  getters, hidden/symbol/extra keys, sparse/decorated arrays and nondata objects.
  Ordinary and null-prototype records are accepted; unexpected reflection failures
  propagate unchanged. No recursive arbitrary-tree validation is performed.
- Preserve blank strings, Unicode/lone surrogates, order and identities. No copying,
  mutation, metadata lookup, fresh limits, membership checks or unit inference.

## Not a mode classifier

Unversioned `{}` remains legacy-mode history but is **not recognizable for
adoption**. Recognition neither changes stored history nor substitutes for fresh
validation, explicit adoption, permissions, conversion, lifecycle or replay rules.
Existing validators, contextual checks and live endpoints are unchanged.
