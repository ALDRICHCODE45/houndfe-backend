# Parse a V2 value without fresh admission

`parseValueShapeV2(unknown): ValueV2` implements the dormant S2 pre-receipt
value boundary from contract §§3/7. It returns a detached closed literal,
composing the existing known-payload and evidence parsers unchanged.

## Accepted shapes

All branches require `code:string`, `owner:product|sellable`, and
`variantId:string|null`, plus these exact fields:

| State            | Payload                              | Evidence                        |
| ---------------- | ------------------------------------ | ------------------------------- |
| `known`          | Required six-branch `KnownPayloadV2` | Required `null` or `EvidenceV2` |
| `unknown`        | Forbidden                            | Required `null`                 |
| `not_applicable` | Forbidden                            | Required `null`                 |

Objects must have plain or null prototypes and only own enumerable data keys.
Accessors, symbols, hidden keys and extras fail without executing getters.
Deliberate parent rejection is `TypeError('Expected a value shape V2')`;
leaf errors and unexpected reflection failures propagate unchanged.

## Not admission or historical recognition

Known false stays distinct from unknown and not applicable. Strings (including
blank/lone-surrogate strings), malformed evidence dates, duplicate multivalues,
null units, signed/fractional numbers, negative zero and reversed ranges survive.
Product owners with non-null variants also pass this shape boundary.

Later gates own membership, owner/variant relationships, uniqueness, scope,
fresh bounds, evidence policy and completeness. This parser does not classify
history, repair values, activate V2, or change document/receipt/HTTP behavior.
