# Canonical production storage rows

`productionVocabularyRows` in `prisma/editorial-production-vocabulary-rows.ts`
projects the approved manifest into the nested raw snapshot representation.
Callers supply complete family IDs keyed by code, definition IDs and matching
types keyed by code, and unit IDs keyed by `JSON.stringify([definitionCode, unitCode])`.
Missing, empty or duplicate consumed IDs within each table namespace and mismatched
definition types throw `TypeError('Invalid production vocabulary storage identity')`.

The pure function does not allocate IDs, mutate inputs, merge customizations,
read a database or apply changes. Unused identity entries do not become rows.
It preserves canonical policies and child relationships, maps unit codes and
archive flags to storage fields, and checks stored materialization plus full
production admission before returning. Provenance is not a storage column.

This is canonical initial data, not an existing-catalog replacement. A subsequent
transactional installer must reconcile existing rows, validate the combined
snapshot, and preserve or explicitly dispose of affected state. SQL writers must
omit joined `definitionCode` and nested collections from individual row inserts.
No loader command or local database activation is provided by this helper.
