/**
 * editorial-live harness — heavy graph loader.
 *
 * Reuses cash-live's Prisma dotenv block (`loadWithPrismaDotenvBlock`): the
 * narrow loader hook is installed BEFORE the generated Prisma client is
 * first required, the Nest + Prisma graph is imported dynamically, and the
 * load fails closed (fixed message) if the client was already loaded or the
 * interception did not happen. Static imports here stay light so server.ts
 * can import this module before its guards have finished.
 */
import { loadWithPrismaDotenvBlock } from '../cash-live/dotenv-isolation';

export async function loadEditorialGraph() {
  return loadWithPrismaDotenvBlock(async () => {
    const liveHarness = await import('./live-harness');
    const seed = await import('./seed');
    const fixture = await import('./fixture');
    const { Logger } = await import('@nestjs/common');
    return { liveHarness, seed, fixture, Logger };
  });
}
