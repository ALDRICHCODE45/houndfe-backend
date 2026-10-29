# V2 known-payload wire shape

`parseKnownPayloadShapeV2(unknown): KnownPayloadV2` checks the closed payload branches before receipt lookup, as specified in [contract §§3/7](catalog-editorial-production-vocabulary-contract-proposal.md). It returns explicit detached objects and a fresh multi array, preserving submitted values and order without mutating even frozen inputs.

| Type          | Required fields beyond `type`                  |
| ------------- | ---------------------------------------------- |
| text / single | `value: string`                                |
| boolean       | `value: boolean`                               |
| number        | finite numeric `value`, `unit: string \| null` |
| multi         | dense plain string array `value`               |
| range         | finite numeric `min` and `max`, `unit: string` |

## Boundary and review checks

- All fields are required own enumerable data properties. Extra keys, symbols, accessors, exotic prototypes and sparse/decorated arrays fail without invoking getters. Ordinary and null-prototype objects are accepted.
- Deliberate rejection throws `TypeError('Expected a known payload shape V2')`. Unexpected reflection failures propagate unchanged, including non-Error thrown values.
- No coercion, sorting, normalization, deduplication or unit repair. False, empty values, signed fractions, negative zero, blank/lone-surrogate strings, unknown codes, duplicate multi entries and equal/reversed range bounds survive this shape boundary.
- Historical recognition and subsequent fresh gates own uniqueness, range ordering, membership, numeric domains, length/count limits and evidence semantics after receipt miss. Passing here proves none of those rules.

This dormant helper does not parse state, keys, evidence, facts, documents or HTTP modes. Existing legacy recognition and canonical JSON serialization are unchanged; the serializer's stricter Unicode rules do not apply here. No runtime activation is included.
