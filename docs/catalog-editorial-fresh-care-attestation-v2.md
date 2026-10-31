# Fresh care attestation V2

`buildFreshCareAttestationV2(input)` is a pure fresh-publish dependency. It checks
care confirmation and exact supplied E coverage, then returns a private audit
payload. It is not registered in HTTP or persistence and does not publish anything.

## Caller preconditions

Inputs remain stable during this synchronous call. The caller supplies:

- Current server-resolved actor/tenant/product scope with read+publish authority.
- A locked fresh attempt after receipt miss and CAS, with current coherent R.
- Valid cycle, Draft and resulting Published counters; a server-owned UTC ISO
  timestamp with milliseconds, never client-provided actor/time/scope.
- A recognizable, fresh reference/capture-admitted document with a resolved family
  and unique actual-subject facts rows.
- Complete, unique E from coordinated same-transaction observation; each identity
  is an actual sellable, including null only for an actual simple subject.
- An already wire-admitted confirmation token: exact `review-v1` or null.

Types and this function do not prove any authorization, locking, E-selection or
fresh-document precondition. Timestamp/counter validation is not duplicated here.

## Owned behavior

Care requires confirmation even when E is empty; non-care forbids confirmation and
returns null. Every E subject must have its own ready prepared review, checked by
`assertCarePublicationReadinessV2`. Missing/unknown/unready coverage rejects with
plain `Error('MALFORMED')`; inactive rows do not add readiness requirements.

Subjects project exactly E's rows to `variantId` and `presentation`, preserving
original facts order rather than E order. Returned subjects are detached and expose
no evidence, review, requirements or warnings. Server metadata is copied exactly.
The digest is `ecd2-sha256-` plus canonical SHA-256 of
`{cycle,draftRevision,document}`. All document array order and inactive rows remain
in the digest; R is recorded separately. Unexpected dependency errors propagate.

## Integration boundary

This builder neither duplicates evaluation readiness nor resolves habitat
equipment-only or custom content/facts association decisions. Later publication
must establish E and writer coordination, all other gates, and atomic state,
receipt and audit persistence. Replay uses the recorded audit without rebuilding
it or requiring renewed confirmation. No public exposure or real-DB proof follows.
