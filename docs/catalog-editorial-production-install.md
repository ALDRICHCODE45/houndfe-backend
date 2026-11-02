# Local production-vocabulary installation

`installProductionVocabulary(client, expectedBeforeSha256, commit = false)` in
`prisma/editorial-production-vocabulary-install.ts` is an internal maintenance
helper, not an HTTP endpoint or a general migration command.

The operator owns target authorization, the database client, a recoverable
backup, and maintenance coordination. Never infer permission from a matching
hash. This helper admits only the legacy starter-only shape, with absent global
metadata and the five unconfigured bindings. It is not an arbitrary catalog merge.

Compute the expected SHA256 over `canonicalEditorialJson` of the snapshot read
by `PrismaEditorialVocabularySnapshot`. The helper locks the nine vocabulary
tables, checks that before-image, validates the proposed combined catalog, writes
parents and children, and validates the public readback within one transaction.
Missing configuration becomes explicit `pending` policy, not a runtime fallback.
Existing starter IDs, options and units remain unchanged; 68 canonical definitions
are added. Product, editorial-state and receipt tables are not modified.

Default execution performs a validated rollback. Only explicit `commit: true`
(via the third positional argument) persists. A stale before-image rejects the
entire operation; rerunning after installation is intentionally rejected rather
than silently overwriting customizations. Lock/statement limits are 5/10 seconds;
the transaction limit is 20 seconds. Any failure aborts the transaction.

The Node lifecycle test requires `EDITORIAL_INSTALL_TEST_DATABASE` and
`EDITORIAL_INSTALL_TEST_URL` for an explicitly owned, restored database named
`editorial_restore_<16 lowercase hex characters>` on loopback port 5432. Run
`node -r ts-node/register --test scripts/editorial-vocabulary-install.test.cjs`.
It never loads dotenv or defaults to the application database. Its successful
commit leaves that disposable target installed; reruns require a fresh authorized
restoration. The test is separate from the offline Jest suite.

Vocabulary success does not prove saved legacy documents are valid V2 documents.
Any state/receipt retirement and browser-readiness check remain separate work.
