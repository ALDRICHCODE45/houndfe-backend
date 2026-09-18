/**
 * Jest globalTeardown (integration config only).
 *
 * The test DB lives in a named Docker volume that survives across
 * `pnpm test:integration` runs (so the next run's `prisma migrate
 * deploy` is a no-op). We don't drop the schema between runs — that
 * is the explicit tradeoff documented in docker-compose.yml.
 *
 * What we DO do: log a static one-liner so an operator tailing the
 * test output knows the run boundary happened. The message carries no
 * connection details — the test DATABASE_URL can embed credentials, so
 * we neither read nor print it here. Jest also clears injected env
 * between globalSetup and globalTeardown in some CI shapes, which is
 * another reason this log stays env-independent.
 */
export default function globalTeardown(): void {
  console.log('[global-teardown] Integration run finished.');
}
