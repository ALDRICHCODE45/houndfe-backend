/**
 * Closes the shared integration PrismaClient after every spec file.
 *
 * Jest resets the module registry per file, so `integrationPrisma()` creates
 * one client per spec; under `--runInBand` the pools of specs that never
 * disconnect pile up until PostgreSQL refuses connections ("too many
 * clients"). `disconnectIntegrationPrisma()` is idempotent, so specs that
 * already call it in their own `afterAll` are unaffected.
 */
import { disconnectIntegrationPrisma } from '../reset-db';

afterAll(async () => {
  await disconnectIntegrationPrisma();
});
