# Recorded editorial state V2

`decodeRecordedEditorialStateV2(unknown): StateV2` admits the recorded state body
from S35 §§8–9. It is dormant and does not decode the complete receipt result.

- Envelope, state, slots, documents and warnings are closed own enumerable data
  records with ordinary or null prototypes. Arrays must be dense and undecorated;
  their prototype is not restricted. Accessors are rejected without invocation.
- Counters remain positive int32 (or null where specified), without cross-counter
  relations. R is exactly `ev2-sha256-` plus 64 lowercase hexadecimal digits.
- Present slots contain direct current-contract documents. Legacy/future documents,
  null documents and obsolete `{mode, document}` wrappers reject the whole state.
- Documents are JSON-validated and detached **before** the existing current-contract
  structural/static-axis recognizer runs. No conversion or fallback mode exists.
- Recorded warning order/duplicates are preserved, including the distinction between
  absent warnings and an explicitly empty array.
- Copies preserve historical strings, dates, null units, negative zero and array
  order. Shared acyclic references produce independent copies. Extra document keys,
  including an own `__proto__`, are invalid under the closed document shape.
  No canonical serialization, fresh limits or current membership checks run.

Intentional rejection remains `TypeError('Expected a recorded editorial state V2')`;
unexpected reflection failures propagate by identity. This proves no authority,
current references, receipt coherence, attestation, storage provenance or replay
eligibility. Full receipt decoding and integration remain separate work.
