/**
 * BatchDeleteOrchestrator - Application orchestrator for batch deletes.
 *
 * Wraps `BatchDeletableService` execution inside
 * `TenantPrismaService.runInTransaction` so the pre-flight validation
 * and the actual delete share one Prisma transaction. Any failure
 * (pre-flight OR executeInTransaction) rolls back the entire batch —
 * the spec's all-or-nothing guarantee.
 *
 * Spec: batch-delete/spec.md R1, R5, R6.
 *
 * Why an abstract class:
 *  - Each bounded context (promotions, future candidates) instantiates
 *    a concrete subclass with the right `BatchDeletableService`
 *    injected. The `forFeature` dynamic module wires that subclass up
 *    so `BatchDeleteController` can ask Nest for the orchestrator.
 *
 * Why `runInTransaction` (not an explicit `tx` arg):
 *  - The repository layer reads from `tenantPrisma.getClient()`, which
 *    in turn reads from the CLS tx slot. Passing a tx explicitly would
 *    require repo-method overloads; ambient tx is the established
 *    codebase pattern.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import { BatchDeleteValidationError } from '../../domain/domain-error';
import type {
  BatchDeletableService,
  BatchDeleteResult,
  ValidationResult,
} from '../batch-delete.types';

@Injectable()
export abstract class BatchDeleteOrchestrator {
  constructor(
    protected readonly tenantPrisma: TenantPrismaService,
    protected readonly service: BatchDeletableService,
  ) {}

  async execute(ids: string[]): Promise<BatchDeleteResult> {
    if (typeof this.tenantPrisma?.runInTransaction !== 'function') {
      // Defensive: surface a programmer error loudly. The ambient-tx
      // contract is what makes pre-flight + delete atomic; without it,
      // a partial commit would be possible. Never silently no-op.
      throw new Error(
        'BatchDeleteOrchestrator requires TenantPrismaService.runInTransaction',
      );
    }

    return this.tenantPrisma.runInTransaction(async () => {
      const validation: ValidationResult =
        await this.service.validateForBatchDeletion(ids);

      if (!validation.valid) {
        // Pre-flight rejection rolls back the tx (we haven't deleted
        // anything yet, but the throw ensures runInTransaction aborts
        // any side effects from the validate query). Filter serializes
        // offendingIds + reason into the response body.
        throw new BatchDeleteValidationError(
          validation.offendingIds ?? [],
          validation.reason ?? 'Batch delete validation failed',
          validation.code ?? 'BATCH_DELETE_FK_CONSTRAINT',
        );
      }

      const deleted = await this.service.executeInTransaction(ids);
      return { deleted };
    });
  }
}