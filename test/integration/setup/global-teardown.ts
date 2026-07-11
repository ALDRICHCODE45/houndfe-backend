/**
 * Jest globalTeardown (integration config only).
 *
 * The test DB lives in a named Docker volume that survives across
 * `pnpm test:integration` runs (so the next run's `prisma migrate
 * deploy` is a no-op). We don't drop the schema between runs — that
 * is the explicit tradeoff documented in docker-compose.yml.
 *
 * What we DO do: log a one-liner so an operator tailing the test
 * output knows the run boundary happened. `process.env.DATABASE_URL`
 * may already be undefined here — Jest clears injected env between
 * globalSetup and globalTeardown in some CI shapes — so we read it
 * defensively.
 */
export default async function globalTeardown(): Promise<void> {
  const url = process.env.DATABASE_URL;
  console.log(
    `[global-teardown] Integration run finished. Targeted DB: ${url ?? '(unresolved)'}.`,
  );
}
