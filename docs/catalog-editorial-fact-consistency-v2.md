# Known-fact consistency V2

`assertFactConsistencyV2(facts)` checks one publication subject's already-qualified
facts (S35/S45, production policy mapping §2). It is dormant, not full publication
admission or registered write-path validation.

## Contradictions

The existing plain `Error('MALFORMED')` rejects each of these pairs independently:

| Known false flag           | Known nonempty subset    |
| -------------------------- | ------------------------ |
| `fitDeterminesChoice`      | `relevantFitCodes`       |
| `capacityDeterminesChoice` | `relevantCapacityCodes`  |
| `electricalApplies`        | `relevantEquipmentCodes` |

The contradiction exists without an associated attribute assertion or scheduled
policy result. This matters for unasserted accessory optional-equipment bindings.
Missing/null flags or subsets, true flags and empty subsets are not contradictions
in this check. True plus missing/empty subsets can still fail selected-policy
readiness; passing here never waives that requirement or S46 optional behavior.

## Caller boundary

The publication caller selects E subjects and passes each subject's stable,
shape/evidence/reference-qualified projection. No sibling lookup, family inference,
raw qualification or evidence validation occurs here. Inputs are not modified.
Known-value contradictions, toy/content agreement, care, numeric admission and
full completeness remain separate gates. This helper does not establish habitat
equipment-only status, inspect bases, qualify baselines or alter receipt replay.
