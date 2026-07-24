/**
 * BatchDeleteModule — dynamic module factory.
 *
 * Each bounded context that wants a batch-delete endpoint calls
 * `BatchDeleteModule.forFeature()` from its NestJS module. The factory:
 *  - registers `BatchDeleteGuard` in the providers list
 *  - imports `AuthModule` so `CaslAbilityFactory` is available to the
 *    guard
 *
 * The consumer wires its own controller method directly:
 *
 *   @Post('batch-delete')
 *   @HttpCode(HttpStatus.OK)
 *   @RequirePermissions(['batch_delete', 'Promotion'])
 *   async batchDelete(
 *     @Body() dto: BatchDeleteDto,
 *   ) {
 *     return this.batchDeleteOrchestrator.execute(dto.ids);
 *   }
 *
 * Why no generated controller: keeping the controller inside the
 * consumer avoids the circular DI problem that arises when
 * `BatchDeleteModule` registers a controller that depends on a
 * service owned by the consumer. The consumer's existing controller
 * already owns `PromotionsService`-shaped dependencies, so adding one
 * more dependency (`BatchDeleteOrchestrator`) is a non-event.
 *
 * Spec: batch-delete/spec.md R3.
 */
import { DynamicModule, Module } from '@nestjs/common';
import { BatchDeleteOrchestrator } from './orchestrator/batch-delete.orchestrator';
import { BatchDeleteGuard } from './guards/batch-delete.guard';
import { AuthModule } from '../../auth/auth.module';

@Module({})
export class BatchDeleteModule {
  static forFeature(): DynamicModule {
    return {
      module: BatchDeleteModule,
      imports: [
        // AuthModule provides CaslAbilityFactory — the dependency
        // BatchDeleteGuard needs to enforce R10.
        AuthModule,
      ],
      providers: [BatchDeleteGuard],
      // Nothing is exported: BatchDeleteOrchestrator is provided by
      // the consumer (with a useFactory that wires TenantPrismaService
      // + the bounded-context BatchDeletableService), and the guard
      // is only used by the consumer's own controller method.
    };
  }
}