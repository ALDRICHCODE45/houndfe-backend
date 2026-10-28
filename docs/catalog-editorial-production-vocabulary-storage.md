# Production vocabulary storage — T3c storage-only

This additive foundation implements persistence for accepted wire v0.5 §6,
private facts v0.2 and total policy mapping v0.1. It activates no reader,
provisioner, public exposure, permissions, document conversion or care gate.

## Wire → storage mapping

| Wire / planner field                | Storage                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Family id/code/label/bindings       | Existing family IDs, codes, labels and bindings                                         |
| minimumContractVersion              | Family integer, default 1, allowed 1/2                                                  |
| Definition id/code/label/type       | Existing IDs; type remains String/TEXT; adds range                                      |
| numericPolicy                       | Nullable definition JSONB; null means unresolved legacy metadata                        |
| units                               | Existing opaque unit ID, definitionId/type composite FK; unitCode/label/order unchanged |
| options                             | Existing (definitionId,code) PK, archive timestamp, label/order unchanged               |
| groups                              | (definitionId,code) PK, label, choice-only definitionType composite FK                  |
| group.optionCodes                   | GroupMember (definitionId,groupCode,optionCode) PK and two scoped composite FKs         |
| aliases                             | Alias (definitionId,label) PK, optionCode scoped FK; no alias ID invented               |
| Binding definitionId/code           | Existing (familyId,definitionId) PK; code obtained from referenced definition           |
| exposure/searchable                 | Binding TEXT/boolean defaults INTERNAL/false                                            |
| policy/publicationCheck             | Nullable binding JSONB/TEXT; route/dispatch is inside policy, not duplicated            |
| semanticsVersion / metadataAddition | Optional singleton VocabularyMetadata id=global, required closed version when present   |

All new FKs use RESTRICT for delete **and** update. Group membership can overlap;
only repeating the identical membership is prohibited. Aliases cannot retarget a
foreign definition's option. Groups only reference single/multi definitions.
Singleton absence represents missing planner metadata; migration inserts no row.
There is no Company model/config, manifest blob or synthetic replacement for legacy keys.

## Constraint boundary and legacy resolution

SQL restricts versions, exposure, publicationCheck and numeric/dispatch JSON outer
shapes/types (including required resolved numeric fields and fact-rule IDs).
COALESCE(false) rejects missing JSON fields rather than CHECK's unknown acceptance.
Deep closed-key validation, finite numeric bounds/order/inclusivity, exact scoped
family/parameter triples, policy case dependencies and legacy compatibility remain
future application/provisioner responsibilities; JSON SQL checks are not full wire validation.
The later V2 snapshot mapper must resolve legacy null numericPolicy to pending,
null policy to pending, and null publicationCheck by an explicitly tested legacy
resolution rule before emitting strict required wire fields. No rule is inferred here.

Existing label checks, unit label/null equivalence, owner checks, composite FKs,
NULLS NOT DISTINCT unit uniqueness and ordering remain intact. Only the exact
editorial_definitions_type_check and editorial_units_definitionType_check are
replaced to add range. Range units require named codes; old number null units remain.
No new identity restrictions are added to legacy tables: even NOT VALID checks
would reject previously permitted updates of historical blank identities.
New group/alias identities and labels must be nonblank. Existing labels are untouched.

## Deployment and proof

Storage migration alone **does not authorize inserting production rows**. Deploy
versioned readers and whole-family legacy filtering/advanced document guards first;
only then may a separately authorized preservation-safe provisioning slice run.
Current reader only emits units for number and options for single/multi and is unchanged.
No migration seed/adoption/update/delete, startup hook, provisioning CLI, grant or
production DB apply is included.

Artifact tests and unchanged focused regressions are structural/mock proof. For
real PostgreSQL 16 verification, explicitly authorize and run:

```sh
bash prisma/editorial-production-metadata.integration.sh
```

Requires Docker and may download postgres:16. It uses a disposable container with
network disabled, tmpfs data, no host volumes and no published ports; it never reads
DATABASE_URL. An EXIT trap removes the container, including on test failure.
It applies the actual four vocabulary migrations to isolated fixtures, checks old
rows/defaults and continued legacy updates, then exercises range units, group
scope/overlaps, aliases, metadata rejection and unchanged rows after rejected SQL.
The test reproduced both the case-sensitive constraint-name failure and the
legacy-update regression before corrections, then passed. Prisma 6.19.2 schema
validation also passed without a database connection. Neither proves production
rollout, V2 reader behavior or vocabulary provisioning.
Rollback boundary: these storage-slice files only, before any provisioning;
no destructive production rollback SQL is supplied or authorized.
