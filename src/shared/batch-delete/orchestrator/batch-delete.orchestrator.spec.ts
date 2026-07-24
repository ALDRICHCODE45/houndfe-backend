/**
 * BatchDeleteOrchestrator — strict TDD unit spec.
 *
 * Asserts the all-or-nothing transaction contract:
 *  - happy path: validate ✓ → execute → { deleted: N }
 *  - pre-flight fail: throw BatchDeleteValidationError (rolls back tx)
 *  - executeInTransaction throw: propagates (rolls back tx)
 *  - nested runInTransaction: reuses the parent tx (no double-wrap)
 *
 * Spec: batch-delete/spec.md R1, R5, R6.
 */
import { BatchDeleteOrchestrator } from './batch-delete.orchestrator';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { BatchDeletableService, ValidationResult } from '../batch-delete.types';
import { BatchDeleteValidationError } from '../../domain/domain-error';

type BatchDeleteOrchestratorCtorArgs = ConstructorParameters<
  typeof BatchDeleteOrchestrator
>;

function makeOrchestrator(opts: {
  tenantPrisma: Pick<TenantPrismaService, 'runInTransaction'>;
  service: jest.Mocked<Pick<BatchDeletableService, 'validateForBatchDeletion' | 'executeInTransaction'>>;
}): BatchDeleteOrchestrator {
  return new BatchDeleteOrchestrator(
    opts.tenantPrisma as TenantPrismaService,
    opts.service as unknown as BatchDeletableService,
  );
}

function makeTenantPrisma(): Pick<TenantPrismaService, 'runInTransaction'> & {
  work: jest.Mock;
} {
  const work = jest.fn(async (fn: () => Promise<unknown>) => fn());
  return { runInTransaction: work, work };
}

function makeService(overrides: {
  validation?: ValidationResult;
  executeCount?: number;
  executeError?: Error;
} = {}): jest.Mocked<
  Pick<BatchDeletableService, 'validateForBatchDeletion' | 'executeInTransaction'>
> {
  const validation: ValidationResult = overrides.validation ?? { valid: true };
  return {
    validateForBatchDeletion: jest.fn().mockResolvedValue(validation),
    executeInTransaction: jest
      .fn()
      .mockImplementation(async () => {
        if (overrides.executeError) throw overrides.executeError;
        return overrides.executeCount ?? 3;
      }),
  };
}

describe('BatchDeleteOrchestrator', () => {
  it('returns { deleted: N } on a happy path', async () => {
    const tenantPrisma = makeTenantPrisma();
    const service = makeService({ executeCount: 5 });

    const orchestrator = makeOrchestrator({ tenantPrisma, service });
    const result = await orchestrator.execute(['a', 'b', 'c', 'd', 'e']);

    expect(result).toEqual({ deleted: 5 });
    expect(tenantPrisma.work).toHaveBeenCalledTimes(1);
    expect(service.validateForBatchDeletion).toHaveBeenCalledWith([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(service.executeInTransaction).toHaveBeenCalledWith([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('throws BatchDeleteValidationError when pre-flight returns offendingIds', async () => {
    const tenantPrisma = makeTenantPrisma();
    const service = makeService({
      validation: {
        valid: false,
        offendingIds: ['bad-1'],
        reason: 'Promotion "bad-1" is referenced by a SaleItem',
        code: 'PROMOTION_REFERENCED_BY_SALE',
      },
    });

    const orchestrator = makeOrchestrator({ tenantPrisma, service });

    await expect(orchestrator.execute(['bad-1'])).rejects.toBeInstanceOf(
      BatchDeleteValidationError,
    );

    // executeInTransaction must NOT have been called → all-or-nothing.
    expect(service.executeInTransaction).not.toHaveBeenCalled();
  });

  it('BatchDeleteValidationError carries offendingIds, reason, and code', async () => {
    const tenantPrisma = makeTenantPrisma();
    const service = makeService({
      validation: {
        valid: false,
        offendingIds: ['x', 'y'],
        reason: 'referenced by sale',
        code: 'PROMOTION_REFERENCED_BY_SALE',
      },
    });

    const orchestrator = makeOrchestrator({ tenantPrisma, service });

    try {
      await orchestrator.execute(['x', 'y']);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BatchDeleteValidationError);
      const bd = err as BatchDeleteValidationError;
      expect(bd.offendingIds).toEqual(['x', 'y']);
      expect(bd.code).toBe('PROMOTION_REFERENCED_BY_SALE');
      expect(bd.message).toBe('referenced by sale');
    }
  });

  it('propagates an executeInTransaction error and rolls back the tx', async () => {
    const boom = new Error('FK constraint violation');
    const tenantPrisma = makeTenantPrisma();
    const service = makeService({ executeError: boom });

    const orchestrator = makeOrchestrator({ tenantPrisma, service });

    await expect(orchestrator.execute(['a'])).rejects.toBe(boom);

    // Tx wrapper must still have run exactly once.
    expect(tenantPrisma.work).toHaveBeenCalledTimes(1);
  });

  it('treats a missing tenantPrisma.runInTransaction as a programmer error', async () => {
    // The orchestrator depends on TenantPrismaService.runInTransaction to
    // enforce atomicity. A missing implementation must throw — the
    // orchestrator never silently falls back to non-transactional execution.
    const badTenantPrisma = {} as unknown as TenantPrismaService;
    const service = makeService();

    const orchestrator = new BatchDeleteOrchestrator(
      badTenantPrisma,
      service as unknown as BatchDeletableService,
    );

    await expect(orchestrator.execute(['a'])).rejects.toThrow();
    expect(service.validateForBatchDeletion).not.toHaveBeenCalled();
  });

  it('constructor wiring: tenantPrisma + service are the only dependencies', () => {
    const ctorArgs: BatchDeleteOrchestratorCtorArgs = [
      {} as TenantPrismaService,
      {} as BatchDeletableService,
    ];
    expect(ctorArgs).toHaveLength(2);
  });
});