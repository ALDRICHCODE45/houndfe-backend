# Materialize stored families without inventing semantics

`materializeStoredFamilyV2(unknown): FamilyV2` is a dormant raw-family mapper.
It validates representation only; it does not activate V2 or change existing readers.

## Boundary

- Guard the whole raw JSON tree before property reads; accessors are rejected without execution.
- Require a family record, a bindings array and exact, required binding `familyId` matches.
- Copy only four family wire fields (`id`, `code`, `label`, `bindings`) and all eight binding wire fields. The raw DB `minimumContractVersion` column is not copied and cannot affect DTO or R. Future storage JSON columns are deliberately omitted, not admitted as semantic metadata.
- Pass each complete policy unchanged to `parseFamilyShapeV2`. Extra semantic policy keys are rejected, not pruned. The parser owns required nonblank strings, enums, safe integer orders, local binding uniqueness and closed policy shapes.
- Missing/null policy, publicationCheck, exposure or searchable fails; no pending/default substitution occurs. Parser errors propagate unchanged.
- Preserve exact strings, binding order and metadata in detached output without mutating frozen input.

## Deliberately deferred

Definition ID/code references and option-case selector/option references require root graph validation, not this leaf. S35/S36 supersedes S18/S29 classification: resolved policies and numeric metadata do not require a family version. Full-production admission remains separate. No implicit unit or production validation is performed.

S2's vocabulary prerequisite and S23's lossless-or-fail boundary motivate this helper. S27's HTTP error mapping remains a future transport obligation; this function introduces no HTTP contract, adoption, publication or activation authority.
