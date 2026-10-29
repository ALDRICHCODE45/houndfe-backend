# V2 write request identity

`createEditorialWriteRequestV2(operation, headers, body)` constructs the detached
closed `ReceiptRequestV2` from normalized semantic headers and a closed wire body.
It records receipt/contract version 2, exact vocabulary revision, adoption,
care confirmation and body. Operation/tenant/product/actor/key scope stays outside.

All three header keys are required; null means absent adoption/confirmation.
Revision is exactly `ev2-sha256-` plus 64 lowercase hex digits (74 characters).
Adoption is null or `legacy-to-v2` on save only; confirmation is null or `review-v1`
on publish only. Conditional requiredness/forbiddenness depending on state waits
until receipt miss and CAS; this helper accepts null on save and publish.

Initialize accepts a null or positive integer cycle. Other bodies require positive
integer cycle/revision; save additionally delegates its document to the unchanged
real shape parser. No safe-integer/storage limit or fresh validation is added.
Closed plain/null-prototype enumerable data records reject accessors, hidden keys,
symbols and extras. Accepted trees are explicitly detached without JSON cloning.
Parent rejection is `TypeError('Expected an editorial write request V2')`;
nested shape errors and unexpected thrown values propagate unchanged.

This dormant helper does not negotiate versions, admit raw duplicate HTTP headers,
authenticate, compare/hash receipts, read metadata/state, perform CAS, store results
or integrate HTTP. The HTTP adapter owns duplicate admission and authority first.
Historical conflicts, strings, null units, duplicate entries and order are preserved.
Tests prove request construction and parser composition, not SQL equality or replay.
