/** Public-facade integration harness over the shared transaction fake. */
import { PrismaCashRegisterApplication } from './prisma-cash-register';
import { makeTenantHarness } from './cash-adapter.test-support';
export {
  actor,
  asItems,
  asJson,
  seedActors,
} from './cash-adapter.test-support';
export type { Host } from './cash-adapter.test-support';

export function makeApp() {
  const { host, tenantPrisma } = makeTenantHarness();
  const app = new PrismaCashRegisterApplication(tenantPrisma);
  return { app, host, tenantPrisma };
}
