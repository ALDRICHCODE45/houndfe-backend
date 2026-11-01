# Operation-owned catalog settings PATCH

`UpdateCatalogSettingsUseCase` owns one settings-local transaction. It rejects an
existing `TenantPrismaService` ambient transaction before database access with
`CatalogSettingsTransactionOwnershipError` (`Catalog settings PATCH requires its
own transaction`). Callers must invoke PATCH outside an ambient transaction;
this is not a nested commit, implicit ambient bypass, or shared after-commit hook.

## Authority and sequence

The controller's existing tenant gate and `manage:all` exception remain unchanged.
The already-authorized route tenant is used for every tenant/binding/coverage
predicate. The adapter does not use the selected-tenant Prisma extension or
change CLS. Global-list existence remains a global lookup. GET retains its
existing repository and selected-context behavior; this change does not broaden
permissions or fix unrelated GET cross-target behavior.

1. Open an owned Read Committed transaction; acquire lifecycle SHARE.
2. Lock the requested Tenant FOR UPDATE; preserve the existing not-found error.
3. Read fresh settings, merge omitted fields, validate requested/default lists,
   and calculate desired-default coverage after both gates.
4. Replace bindings/publication/stock settings, reload, and materialize the entire
   response inside the transaction. The repository's repeated Tenant lock is
   reentrant; it does not create another transaction or upgrade lifecycle mode.
5. Await actual commit, then emit the unchanged allowlisted best-effort audit.
   Audit emission failure cannot reject an already-committed PATCH. Read, write,
   reload, response, or commit failure produces no audit and no partial mutation.

## Evidence boundaries

Offline composition exercises the real use case, adapter, repository, controller
scope gate, and CLS service against instrumented Prisma delegates. It checks
selected-versus-target confinement, gate ordering, fresh post-wait observations,
coverage, response and completion failures, ambient rejection, and audit timing.
The existing business-contract suite remains applicable.

`catalog-settings-update-coordination.live.spec.ts` authors five separately
admitted PostgreSQL schedules: lifecycle wait, fresh Tenant wait, completion
commit/rollback, and ambient rejection. They use disposable binding admission;
they have **not been executed**. Mock rollback is not PostgreSQL rollback proof.
No production services, grants, migrations, shared factories, Product deletion,
frontend cutover, full editorial publication, or public C3.3 are activated here.
