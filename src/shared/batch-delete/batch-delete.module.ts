/**
 * BatchDeleteModule — dynamic module factory.
 *
 * Each bounded context that wants a batch-delete endpoint calls
 * `BatchDeleteModule.forFeature({ subject, path, service })` from its
 * NestJS module. The factory:
 *  - builds a concrete `BatchDeleteOrchestrator` subclass wired with
 *    the supplied `BatchDeletableService`
 *  - generates the controller class via `POST({ subject, path })`
 *  - registers `BatchDeleteGuard` in the providers list
 *
 * The feature module must add the returned `controllers` to its own
 * `controllers` array (see `PromotionsModule` for the wiring pattern).
 *
 * Spec: batch-delete/spec.md R3.
 */
import {
  DynamicModule,
  Module,
  Provider,
  Type,
} from '@nestjs/common';
import type { AppSubjects } from '../../auth/authorization/domain/permission';
import { BatchDeleteOrchestrator } from './orchestrator/batch-delete.orchestrator';
import { BatchDeleteGuard } from './guards/batch-delete.guard';
import { BatchDeletableService } from './batch-delete.types';
import { POST } from './controller/batch-delete.controller';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';

export interface BatchDeleteFeatureOptions {
  subject: AppSubjects;
  /** NestJS controller path (e.g. `'promotions'`). */
  path: string;
  /** Token under which the `BatchDeletableService` is registered in DI. */
  serviceToken: symbol | Type<BatchDeletableService>;
  /**
   * The concrete service class to instantiate when constructing the
   * orchestrator. Used only as a type anchor for the factory — the
   * NestJS container resolves the instance from `serviceToken`.
   */
  serviceClass: Type<BatchDeletableService>;
}

@Module({})
export class BatchDeleteModule {
  static forFeature(options: BatchDeleteFeatureOptions): DynamicModule {
    const OrchestratorClass = this.buildOrchestrator(
      options.serviceClass,
    );
    const ControllerClass = POST({
      subject: options.subject,
      path: options.path,
    });

    const orchestratorProvider: Provider = {
      provide: BatchDeleteOrchestrator,
      useFactory: (
        tenantPrisma: TenantPrismaService,
        service: BatchDeletableService,
      ): BatchDeleteOrchestrator => new OrchestratorClass(tenantPrisma, service),
      inject: [TenantPrismaService, options.serviceToken],
    };

    return {
      module: BatchDeleteModule,
      controllers: [ControllerClass],
      providers: [BatchDeleteGuard, orchestratorProvider],
      exports: [BatchDeleteOrchestrator, BatchDeleteGuard],
    };
  }

  /**
   * Build a concrete `BatchDeleteOrchestrator` subclass that knows the
   * concrete `BatchDeletableService` constructor type. The runtime
   * instance comes from the NestJS container — this helper exists
   * purely to anchor the type so `new OrchestratorClass(...)` type-
   * checks against `BatchDeletableService`.
   */
  private static buildOrchestrator(
    serviceClass: Type<BatchDeletableService>,
  ): Type<BatchDeleteOrchestrator> {
    class TypedOrchestrator extends BatchDeleteOrchestrator {
      constructor(
        tenantPrisma: TenantPrismaService,
        service: BatchDeletableService,
      ) {
        super(tenantPrisma, service);
      }
    }
    // Make the constructor parameter `service` know its declared type
    // — purely cosmetic for tooling; the runtime accepts any
    // BatchDeletableService.
    void serviceClass;
    return TypedOrchestrator as Type<BatchDeleteOrchestrator>;
  }
}