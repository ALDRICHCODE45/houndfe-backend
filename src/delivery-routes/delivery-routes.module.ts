/**
 * MODULE: DeliveryRoutesModule — delivery-routes / WU2.
 *
 * Wires the bounded context:
 *   - Controller + service
 *   - `DELIVERY_ROUTE_REPOSITORY` → `PrismaDeliveryRouteRepository`
 *   - `ROUTE_OPTIMIZER` → `ManualRouteOptimizer` (identity for MVP)
 *   - `SubjectInstanceResolverRegistry.register('DeliveryRoute', ...)`
 *     so the `PermissionsGuard` can evaluate the
 *     `{ driverUserId: userId }` condition (design ADR-5). The
 *     registry is a module-scoped static map; we register the resolver
 *     at module construction (NestJS calls providers' factory functions
 *     at boot, so the map is populated before any request hits the
 *     guard).
 *
 * Imports:
 *   - `AuthModule` — `JwtAuthGuard`, `TenantContextGuard`,
 *     `PermissionsGuard`, `@CurrentUser`, `@RequirePermissions`,
 *     `CaslAbilityFactory`.
 *   - `SalesModule` — exposes the `SALE_REPOSITORY` Symbol token that
 *     `DeliveryRoutesService` consumes for the Sale mirror flip inside
 *     the check-in transaction.
 *
 * Outbox/Inngest/email wiring arrives in WU3 (own module). WU2 keeps
 * the registry slot empty so the `DeliveryRoute` resolver is the only
 * addition at the auth boundary.
 */
import { Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SalesModule } from '../sales/sales.module';
import { DeliveryRoutesController } from './presentation/delivery-routes.controller';
import { DeliveryRoutesService } from './application/delivery-routes.service';
import { PrismaDeliveryRouteRepository } from './infrastructure/prisma-delivery-route.repository';
import { ManualRouteOptimizer } from './infrastructure/manual-route-optimizer';
import { DELIVERY_ROUTE_REPOSITORY } from './domain/delivery-route.repository';
import { ROUTE_OPTIMIZER } from './domain/ports/route-optimizer.port';
import {
  SubjectInstanceResolver,
  SubjectInstanceResolverRegistry,
} from '../auth/authorization/subject-instance-resolver';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';

/**
 * Side-effect provider: registers the DeliveryRoute subject-instance
 * resolver into the static registry at module-init time. Implemented as
 * a provider with a factory that returns a no-op sentinel value so the
 * NestJS DI graph treats it as a leaf.
 */
const DELIVERY_ROUTE_SUBJECT_RESOLVER = Symbol.for(
  'DeliveryRouteSubjectResolverRegistrar',
);

@Injectable()
class DeliveryRouteSubjectResolverRegistrar implements OnApplicationBootstrap {
  constructor(
    @Inject(DELIVERY_ROUTE_REPOSITORY)
    private readonly repo: PrismaDeliveryRouteRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  onApplicationBootstrap(): void {
    const resolver: SubjectInstanceResolver = {
      async resolveSubject(req) {
        const params = (req?.params ?? {}) as { id?: unknown };
        const id = typeof params.id === 'string' ? params.id : null;
        if (!id) return null;
        let tenantId: string;
        try {
          tenantId = this.tenantPrisma.getTenantId();
        } catch {
          return null;
        }
        return this.repo.findDriverUserIdById({ tenantId, id });
      },
    };
    SubjectInstanceResolverRegistry.register('DeliveryRoute', resolver);
  }
}

@Module({
  imports: [AuthModule, SalesModule],
  controllers: [DeliveryRoutesController],
  providers: [
    DeliveryRoutesService,
    {
      provide: DELIVERY_ROUTE_REPOSITORY,
      useClass: PrismaDeliveryRouteRepository,
    },
    {
      provide: ROUTE_OPTIMIZER,
      useClass: ManualRouteOptimizer,
    },
    {
      // Side-effect provider: registers the DeliveryRoute subject-
      // instance resolver into the static registry at
      // `onApplicationBootstrap` time. The Guard reads the registry on
      // every `canActivate` call so late registration is safe.
      provide: DELIVERY_ROUTE_SUBJECT_RESOLVER,
      useClass: DeliveryRouteSubjectResolverRegistrar,
    },
  ],
  exports: [DeliveryRoutesService],
})
export class DeliveryRoutesModule {}
