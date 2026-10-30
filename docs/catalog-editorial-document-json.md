# Editorial document JSON type

`EditorialDocumentJson` recursively represents null, booleans, numbers, strings,
arrays and string-keyed objects. It is exported from the type-only module
`src/catalog-editorial/domain/editorial-document-json.ts`.

Callers must supply already-decoded JSON with finite numbers; TypeScript's
`number` cannot express finiteness. Transport validation belongs to the caller.
Undefined, functions and cycles are outside this type's preconditions; the module
provides no unknown-input JSON-tree validator.

This type establishes no document recognition, save/publish admission or
activation guarantee.
