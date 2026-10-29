# Recorded receipt result V2

Dormant `decodeRecordedReceiptResultV2(operation, request, input)` implements the
recorded shape boundary in contract §4 and private facts §3.
The request is already admitted and corresponds to the supplied write operation.
This is not a request parser or a fresh-state validator.

The closed internal result retains status, recorded StateV2, semantic headers and
private care attestation. It is **not an HTTP DTO**; never expose the attestation.
Body decoding delegates unchanged to the recorded-state decoder, preserving modes,
raw history and warning presence. Nested and unexpected errors must propagate.

Attestation is required only for confirmed publish, otherwise null. Its syntax and
request/body revision coherence do not prove digest truth, subject E coverage,
authorized actor/scope, care family, eligibility or legal compliance. These are
server recording preconditions, not codec claims. Historical strings and canonical
UTC millisecond timestamps gain no fresh limits or clock checks. Canonical Date
ISO round-trips include extended years. Positive int32 counters bind cycle to
request/state, draft revision to request and published revision to recorded Published;
request, body, header and attestation vocabulary revisions agree. No lifecycle or cross-counter arithmetic is added.

No storage, replay activation, HTTP wiring, current metadata lookup, digest
recomputation or fresh publication validation is included. Closed plain/null-prototype
data records and dense undecorated arrays are detached without invoking accessors;
subject order, duplicates and empty arrays remain intact. Initialize requires 201;
other operations require 200. No receipt-status inference is performed.
