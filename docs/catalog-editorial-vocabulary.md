# Editorial vocabulary: storage and starter seed

U4a implements storage and seed only. HTTP vocabulary delivery is deferred to
U4b; no endpoint or application bootstrap wiring is added here.

## Migration (not executed)

`20261027080000_editorial_vocabulary` is additive and transactional. Labels are
backfilled before constraints; no identities or codes are changed:

- Families and definitions: preserve nonblank code as label, otherwise use id.
- Options: preserve nonblank code, otherwise use definitionId (options have a
  composite primary key, not an id column).
- Units: null unitCode means null label; preserve nonblank unitCode, otherwise
  use id. A CHECK enforces null label exactly when unitCode is null.
- All non-null labels must satisfy `btrim(label) <> ''`.
- Bindings, options and units receive integer sortOrder = 0 before NOT NULL;
  there are no defaults. Future writers must supply labels and order explicitly.

Backfill fallback keys must themselves be nonblank. Existing schema does not
constrain key whitespace; anomalous blank keys cause transactional failure,
never silent identity replacement. Review such data separately before deployment.

## Explicit seed (not executed)

After separately authorized migration deployment, explicitly run
`pnpm run seed:editorial-vocabulary` against a separately authorized target.
The command uses existing Prisma connection configuration; it does not generate
a client or migrate. Imports do not connect. NODE_ENV=test blocks the CLI branch;
unit tests use a fake client and never execute the seed CLI.
No bootstrap, default Prisma seed, test script or deployment hook invokes it.

`prisma/editorial-vocabulary-seed.data.ts` contains STARTER_V1: one visibly marked
starter family with text, boolean, number, single and multi definitions, options,
and nullable/kg units. This is NOT an approved production taxonomy. Vocabulary
content is a product decision; extend the versioned data through reviewed PRs.

The CLI runs all parameterized raw SQL upserts in one transaction, compatible
with the installed client lacking editorial delegates. Codes resolve existing
family/definition ids; existing option/unit keys are retained. Labels, types,
owners and sortOrder follow data. Omitted entries are never deleted. Existing
archivedAt is preserved unless archived:true requests archival; repeated archival
preserves its original timestamp. archived:false does not unarchive. Changing a
definition type with incompatible children fails existing foreign-key constraints
and rolls back; plan such content transitions explicitly. No version field is
added to the future HTTP contract.

## Endpoints

`GET /catalog-editorial/vocabulary` returns the closed §3.1 Vocabulary shape.
JWT and tenant guards require a concrete principal tenant; current active user,
qualified membership and exact `ProductEditorialDraft:read` are checked afresh.
There is no `manage` fallback or product lookup: content is company-wide.
Families sort by label/code; definitions by code; bindings/options/units by
sortOrder/code (null unit code first). Empty collections remain arrays; archived
options remain listed. Labels and nullable unit labels come from storage.
Success and editorial `{statusCode,error}` failures carry `Cache-Control: no-store`.
Query strings are rejected with `400 MALFORMED`. No pagination or version field.
This endpoint requires the separately authorized U4a migration before deployment;
mocked tests do not execute SQL or validate database collation.
