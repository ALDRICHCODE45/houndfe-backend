# Conservation baseline eligibility V2

`eligibleConservationBaselineV2(input, references, vocabulary)` returns a detached
whole document or `null`. It implements the S42 eligibility boundary only.

## What qualifies

The input must be structurally recognizable V2, including static fact-axis unions.
Every document reference must pass current membership, owner, subject, type and
uniqueness checks. A later invalid row invalidates the entire baseline; nothing
is salvaged per assignment. Archived options remain reference members.

Fresh evidence dates, numeric policies, text limits, facts qualification and care
capture validity are not baseline checks. Historical failures of those rules do
not erase conservation eligibility. Fresh candidates still need independent
admission. Eligibility alone never permits retaining an archived assignment.

## Caller responsibilities

Supply coherent admitted vocabulary and qualified, stable references. Select the
correct provenance: stored Draft for save, current Published for publish (absent
Published grants none). This helper neither selects nor writes stored state.

Intentional shape/static/reference rejection returns `null`; unexpected failures
propagate. Only the reference call translates its plain `Error('MALFORMED')`.
Recognition observes a detached parsed snapshot. Inputs are not mutated.

No fresh gate, canonical serialization, warnings, replay reconstruction, HTTP
registration, initialization-copy validation or archive identity replacement is
introduced. Option conservation and warning generation are separate consumers.
