/**
 * Where the modules that react to a RESTOCK resolution register themselves
 * (see `restock-resolution.listener.ts`). Provided and exported by
 * `HumanDecisionsModule`.
 *
 * Isolation: every listener runs inside a SAVEPOINT of the resolver's
 * transaction. A listener that throws has ONLY its own writes rolled back, the
 * error is logged (ids only) and the staff resolution is kept: an existing
 * RESTOCK flow never fails because of a listener. The listener's own recovery
 * path (for the backorders: the sweep's «apply a resolved re-estimate») covers
 * what the savepoint rolled back.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  RestockResolutionListener,
  RestockResolvedEvent,
} from '../domain/restock-resolution.listener';

@Injectable()
export class RestockResolutionRegistry {
  private readonly logger = new Logger(RestockResolutionRegistry.name);
  private readonly listeners: RestockResolutionListener[] = [];

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  register(listener: RestockResolutionListener): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  get size(): number {
    return this.listeners.length;
  }

  /** Call inside the resolver's transaction, after the CAS and the request close. */
  async notify(event: RestockResolvedEvent): Promise<void> {
    if (this.listeners.length === 0) return;
    const db = this.tenantPrisma.getClient();
    for (const listener of this.listeners) {
      await db.$executeRaw`SAVEPOINT restock_resolution_listener`;
      try {
        await listener.onRestockResolved(event);
        await db.$executeRaw`RELEASE SAVEPOINT restock_resolution_listener`;
      } catch (error) {
        await db.$executeRaw`ROLLBACK TO SAVEPOINT restock_resolution_listener`;
        await db.$executeRaw`RELEASE SAVEPOINT restock_resolution_listener`;
        this.logger.error(
          `RESTOCK resolution listener failed for decision ${event.decisionId}; its writes were rolled back and the resolution kept: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
      }
    }
  }
}
