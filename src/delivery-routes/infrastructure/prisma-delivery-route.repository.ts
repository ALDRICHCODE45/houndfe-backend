/**
 * ADAPTER: PrismaDeliveryRouteRepository — delivery-routes / WU2.
 *
 * Concrete implementation of `IDeliveryRouteRepository` using Prisma.
 * Tenant scoping is delegated to `TenantPrismaService` (CLS-driven
 * WHERE-injection; see `src/shared/prisma/tenant-prisma.factory.ts`).
 * `DeliveryRoute` and `DeliveryRouteStop` are both in
 * `TENANT_SCOPED_MODELS` so every read/write gets auto-filtered by
 * `tenantId` at the top-level `where`/`data`.
 *
 * P2002 → 409 mapping: the partial unique index
 * `delivery_route_stops_active_sale_uniq` on
 * `(tenant_id, sale_id) WHERE activeRouteId IS NOT NULL` raises
 * `P2002` when a concurrent route-start race violates the invariant.
 * The adapter maps that to
 * `DeliveryRouteSaleAlreadyInActiveRouteError` (HTTP 409 via the
 * global filter's `BusinessRuleViolationError` branch — see design §9
 * error table).
 *
 * The outbox-claim trio (`claimNextOutboxEvent` / `markOutboxEventSent` /
 * `markOutboxEventFailed`) is stubbed with `null` / no-ops for WU2;
 * WU3's dedicated poller/dispatcher overrides the behavior with real
 * SQL. Keeping the signatures in the WU2 port + adapter means WU3 can
 * swap implementations without churning the service contract.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { DeliveryRoute } from '../domain/delivery-route.entity';
import { DeliveryRouteSaleAlreadyInActiveRouteError } from '../domain/delivery-route.errors';
import type {
  DeliveryRouteReadModel,
  IDeliveryRouteRepository,
  ListDeliveryRoutesInput,
} from '../domain/delivery-route.repository';

@Injectable()
export class PrismaDeliveryRouteRepository implements IDeliveryRouteRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private getClient(): ReturnType<TenantPrismaService['getClient']> {
    return this.tenantPrisma.getClient();
  }

  async save(route: DeliveryRoute): Promise<DeliveryRoute> {
    const prisma = this.getClient();
    const data = route.toPersistence();

    try {
      // Parent row first — upsert preserves the same id on subsequent
      // saves (create on first call, update thereafter). `updatedAt` is
      // bumped on every mutation per the design contract.
      await prisma.deliveryRoute.upsert({
        where: { id: route.id },
        create: {
          id: data.id,
          tenantId: data.tenantId,
          driverUserId: data.driverUserId,
          status: data.status,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          cancelledAt: data.cancelledAt,
          notes: data.notes,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
        update: {
          driverUserId: data.driverUserId,
          status: data.status,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          cancelledAt: data.cancelledAt,
          notes: data.notes,
          updatedAt: data.updatedAt,
        },
      });

      // Child stops: delete-then-recreate so the aggregate is the
      // single source of truth. The P2002 raised by the
      // `(tenantId, saleId) WHERE activeRouteId IS NOT NULL` partial
      // unique index surfaces from this createMany — caught below and
      // translated to a 409.
      await prisma.deliveryRouteStop.deleteMany({
        where: { routeId: route.id },
      });
      if (data.stops.length > 0) {
        await prisma.deliveryRouteStop.createMany({
          data: data.stops.map((stop) => ({
            id: stop.id,
            tenantId: stop.tenantId,
            routeId: stop.routeId,
            saleId: stop.saleId,
            sortOrder: stop.sortOrder,
            status: stop.status,
            checkedInAt: stop.checkedInAt,
            completedAt: stop.completedAt,
            skippedReason: stop.skippedReason,
            activeRouteId: stop.activeRouteId,
            createdAt: stop.createdAt,
            updatedAt: stop.updatedAt,
          })),
        });
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // ADR-7 — the partial unique index
        // `delivery_route_stops_active_sale_uniq` raised. Translate to
        // the canonical 409 domain error so the global filter maps it
        // to HTTP 409 (design §9).
        throw new DeliveryRouteSaleAlreadyInActiveRouteError(
          'One or more sales already belong to another active route',
          {
            reason: 'PARTIAL_UNIQUE_INDEX_VIOLATION',
            routeId: route.id,
          },
        );
      }
      throw error;
    }

    return (await this.findById({ tenantId: data.tenantId, id: route.id }))!;
  }

  async findById(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRoute | null> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      include: { stops: true },
    });
    if (!row) return null;
    return DeliveryRoute.fromPersistence({
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as
        | 'DRAFT'
        | 'ACTIVE'
        | 'COMPLETED'
        | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stops: row.stops.map((stop) => ({
        id: stop.id,
        tenantId: stop.tenantId,
        routeId: stop.routeId,
        saleId: stop.saleId,
        sortOrder: stop.sortOrder,
        status: stop.status as
          | 'PENDING'
          | 'IN_PROGRESS'
          | 'COMPLETED'
          | 'SKIPPED',
        checkedInAt: stop.checkedInAt,
        completedAt: stop.completedAt,
        skippedReason: stop.skippedReason,
        activeRouteId: stop.activeRouteId,
        createdAt: stop.createdAt,
        updatedAt: stop.updatedAt,
      })),
    });
  }

  async findOneWithStops(input: {
    tenantId: string;
    id: string;
  }): Promise<DeliveryRouteReadModel | null> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      include: {
        driver: { select: { id: true, name: true, email: true } },
        stops: {
          orderBy: { sortOrder: 'asc' },
          include: {
            sale: {
              select: {
                id: true,
                folio: true,
                customer: {
                  select: { id: true, firstName: true, lastName: true, email: true },
                },
                shippingAddress: {
                  select: {
                    id: true,
                    street: true,
                    exteriorNumber: true,
                    interiorNumber: true,
                    zipCode: true,
                    neighborhood: true,
                    municipality: true,
                    city: true,
                    state: true,
                    label: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as
        | 'DRAFT'
        | 'ACTIVE'
        | 'COMPLETED'
        | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      driver: row.driver
        ? {
            id: row.driver.id,
            name: row.driver.name,
            email: row.driver.email,
          }
        : null,
      stops: row.stops.map((stop) => {
        const customer = stop.sale?.customer ?? null;
        const addr = stop.sale?.shippingAddress ?? null;
        return {
          id: stop.id,
          saleId: stop.saleId,
          saleFolio: stop.sale?.folio ?? null,
          sortOrder: stop.sortOrder,
          status: stop.status as
            | 'PENDING'
            | 'IN_PROGRESS'
            | 'COMPLETED'
            | 'SKIPPED',
          checkedInAt: stop.checkedInAt,
          completedAt: stop.completedAt,
          customer: customer
            ? {
                id: customer.id,
                name: `${customer.firstName}${customer.lastName ? ' ' + customer.lastName : ''}`,
                email: customer.email ?? null,
              }
            : null,
          shippingAddress: addr
            ? {
                id: addr.id,
                street: addr.street,
                exteriorNumber: addr.exteriorNumber,
                interiorNumber: addr.interiorNumber,
                zipCode: addr.zipCode,
                neighborhood: addr.neighborhood,
                municipality: addr.municipality,
                city: addr.city,
                state: addr.state,
                label: addr.label,
              }
            : null,
        };
      }),
    };
  }

  async list(
    input: ListDeliveryRoutesInput,
  ): Promise<DeliveryRouteReadModel[]> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const where: Prisma.DeliveryRouteWhereInput = { tenantId };
    if (input.driverUserId) {
      where.driverUserId = input.driverUserId;
    }
    if (input.status && input.status.length > 0) {
      where.status = { in: input.status };
    }
    const rows = await prisma.deliveryRoute.findMany({
      where,
      include: {
        driver: { select: { id: true, name: true, email: true } },
        stops: {
          orderBy: { sortOrder: 'asc' },
          include: {
            sale: {
              select: {
                id: true,
                folio: true,
                customer: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
                shippingAddress: {
                  select: {
                    id: true,
                    street: true,
                    exteriorNumber: true,
                    interiorNumber: true,
                    zipCode: true,
                    neighborhood: true,
                    municipality: true,
                    city: true,
                    state: true,
                    label: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      driverUserId: row.driverUserId,
      status: row.status as
        | 'DRAFT'
        | 'ACTIVE'
        | 'COMPLETED'
        | 'CANCELLED',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      driver: row.driver
        ? {
            id: row.driver.id,
            name: row.driver.name,
            email: row.driver.email,
          }
        : null,
      stops: row.stops.map((stop) => {
        const customer = stop.sale?.customer ?? null;
        const addr = stop.sale?.shippingAddress ?? null;
        return {
          id: stop.id,
          saleId: stop.saleId,
          saleFolio: stop.sale?.folio ?? null,
          sortOrder: stop.sortOrder,
          status: stop.status as
            | 'PENDING'
            | 'IN_PROGRESS'
            | 'COMPLETED'
            | 'SKIPPED',
          checkedInAt: stop.checkedInAt,
          completedAt: stop.completedAt,
          customer: customer
            ? {
                id: customer.id,
                name: `${customer.firstName}${customer.lastName ? ' ' + customer.lastName : ''}`,
                email: customer.email ?? null,
              }
            : null,
          shippingAddress: addr
            ? {
                id: addr.id,
                street: addr.street,
                exteriorNumber: addr.exteriorNumber,
                interiorNumber: addr.interiorNumber,
                zipCode: addr.zipCode,
                neighborhood: addr.neighborhood,
                municipality: addr.municipality,
                city: addr.city,
                state: addr.state,
                label: addr.label,
              }
            : null,
        };
      }),
    }));
  }

  async findDriverUserIdById(input: {
    tenantId: string;
    id: string;
  }): Promise<{ driverUserId: string } | null> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      select: { driverUserId: true },
    });
    return row ? { driverUserId: row.driverUserId } : null;
  }

  async delete(input: { tenantId: string; id: string }): Promise<void> {
    const prisma = this.getClient();
    const tenantId = input.tenantId;
    // Adapter-side precondition: only DRAFT routes with zero stops may
    // be hard-deleted. The aggregate's `canDelete()` pre-checks in the
    // service; the adapter re-validates to keep the guard rails close
    // to the persistence call.
    const row = await prisma.deliveryRoute.findFirst({
      where: { id: input.id, tenantId },
      include: { stops: { take: 1 } },
    });
    if (!row) {
      // Already gone — idempotent.
      return;
    }
    if (row.status !== 'DRAFT' || row.stops.length > 0) {
      throw new BusinessRuleViolationError(
        'DeliveryRoute can only be deleted when DRAFT with no stops',
        'DELIVERY_ROUTE_INVALID_TRANSITION',
      );
    }
    await prisma.deliveryRoute.delete({ where: { id: input.id } });
  }

  async runInTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient() as unknown as Prisma.TransactionClient;
      return work(tx);
    });
  }

  // ── Outbox seam (WU3 poller/dispatcher overrides) ───────────────────
  // WU2 ships stubs because the port contract requires the methods to
  // exist. The WU3 poller/dispatcher rewires them with the
  // dedicated-claim SQL; until then, the methods throw so any
  // accidental WU2 path that reaches them fails loudly.

  async claimNextOutboxEvent(): Promise<unknown | null> {
    throw new BusinessRuleViolationError(
      'claimNextOutboxEvent is not implemented in WU2',
      'OUTBOX_NOT_WIRED',
    );
  }

  async markOutboxEventSent(): Promise<void> {
    throw new BusinessRuleViolationError(
      'markOutboxEventSent is not implemented in WU2',
      'OUTBOX_NOT_WIRED',
    );
  }

  async markOutboxEventFailed(): Promise<void> {
    throw new BusinessRuleViolationError(
      'markOutboxEventFailed is not implemented in WU2',
      'OUTBOX_NOT_WIRED',
    );
  }

  getTransactionClient(): Prisma.TransactionClient | null {
    if (!this.tenantPrisma.isInTransaction()) {
      return null;
    }
    return this.tenantPrisma.getClient() as unknown as Prisma.TransactionClient;
  }
}
