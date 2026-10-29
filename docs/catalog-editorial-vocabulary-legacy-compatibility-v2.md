# Conservative declared-V1 family compatibility

`assertFamilyLegacyCompatibilityV2(family, definitionsById): void` is a dormant
trusted-input assertion implementing S18. It rejects contradictory new V1
candidates without promoting the family or pruning bindings. Nothing invokes it
from historical reads, writes, receipt replay or runtime vocabulary consumers.

## Declaration rules

| Declaration                 | Required by this check                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `minimumContractVersion: 1` | Every binding policy has route `pending`; every bound definition is text, boolean, number, single or multi; every number has numericPolicy status `pending`. |
| `minimumContractVersion: 2` | Passes this declaration check, not full admission.                                                                                                           |

Range is always advanced, even pending. Any resolved number is advanced, including
unbounded `integer:false` metadata. Every `option_cases` and `fact_rule` is advanced,
including empty cases and unconditional apparently neutral cases. No semantic
neutrality exceptions are inferred. Pending is a legacy classification, **not**
proof of V2 publication safety.

## Caller and preservation boundaries

First parse the family, validate all definitions, establish unique IDs/codes and
check references; the map must use actual definition IDs. Keep inputs stable
throughout the synchronous assertion. `validateVocabularyConsistencyV2` supplies
these generic checks, but does not itself invoke this compatibility assertion.
This helper does not repeat shape, collision or reference validation.

Only bound definitions are examined, by exact binding ID, never by code fallback.
Unbound advanced definitions are ignored; an empty family passes. No seven-family
completeness or all-five-types requirement is introduced. Success returns void;
contradiction throws `TypeError('Expected a legacy-compatible family V2')` for the
whole family, without mutation, deletion or implicit version promotion.

Owners (product/sellable), null units, empty choices, archives, groups, aliases,
labels, exposure, searchability and submitted order remain unchanged. No defaults
or publication permissions are created. Production reserved names/exact mapping
(S14) and explicit adoption remain separate: passing this generic V1 check never
authorizes canonical legacy adoption. Projection, transport activation and full
vocabulary/publication admission remain pending separate work.
