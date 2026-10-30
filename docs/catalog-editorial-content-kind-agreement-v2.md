# Canonical content-kind agreement V2

`assertContentKindAgreementV2(kind, contentMagnitude)` checks one local
publication agreement (S35/S45/S52). It is not a publication-readiness validator
and is not wired into HTTP, persistence or publication execution.

## Caller contract

The caller selects the canonical `content.kind` assignment (`ValueV2 | undefined`)
and the matching subject's already-qualified `contentMagnitude`. Its type is
derived from `FactInputsV2['contentMagnitude']`; omitted/null means unknown.
Inputs must remain stable during the synchronous check. Shape, metadata,
reference, subject and evidence admission are preconditions, not performed here.
The caller establishes that the assignment and fact belong together; this helper
does not choose an owner, aggregate variants, schedule E, or resolve product-owned
custom assignments against sellable facts.

## Agreement

| Exact option identity | Required known magnitude |
| --------------------- | ------------------------ |
| `content.kind.mass`   | `mass`                   |
| `content.kind.volume` | `volume`                 |
| `content.kind.count`  | `count`                  |
| `content.kind.length` | `length`                 |
| `content.kind.area`   | `area`                   |

These are the five identities in the production choice inventory. Labels,
aliases, prefixes and numeric values never supply a mapping. A known assertion
requires a known matching magnitude even in an otherwise optional context.
An unmapped extra option rejects until explicitly mapped. Canonical identities
retain this same meaning in custom families; accepted vocabulary extras alone
cannot establish agreement.

Absent, unknown and explicit-NA kind skip this comparison. Skipping does not
admit NA or waive any other gate. A mismatch, unmapped option or missing/null
magnitude for known kind throws the existing plain `Error('MALFORMED')`.
An encountered known non-single payload violates the admitted-input precondition
and throws `TypeError`, rather than silently becoming a nonmatch.

Inputs are not changed. Numeric policy, evidence validation, facts qualification,
NA admission, owner/subject selection and complete publication integration remain
separate responsibilities; local agreement proves none of them.
