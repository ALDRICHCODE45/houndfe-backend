/**
 * batch-delete.types — public types and abstract service contract
 * for the cross-cutting batch-delete abstraction.
 *
 * Spec: batch-delete/spec.md R4 (Service contract).
 */
export interface BatchDeleteResult {
  deleted: number;
}

export interface ValidationResult {
  valid: boolean;
  offendingIds?: string[];
  reason?: string;
  code?: string;
}

/**
 * Abstract service contract for batch-deletable bounded contexts.
 *
 * Implementors (e.g. `PromotionsService`) MUST run inside the
 * ambient CLS transaction supplied by `BatchDeleteOrchestrator` —
 * they obtain the transactional client via
 * `tenantPrisma.getClient()`. Both methods MUST be safe to invoke
 * from inside `TenantPrismaService.runInTransaction`.
 *
 *   - `validateForBatchDeletion(ids)` returns a `ValidationResult`
 *     describing whether any ID in the batch fails pre-flight
 *     (FK references, tenant ownership, etc.). On failure the result
 *     MUST include `offendingIds`, a `reason`, and a `code` that
 *     downstream filters can route to the right HTTP status.
 *
 *   - `executeInTransaction(ids)` performs the actual deletion and
 *     returns the row count. It MUST assume `validateForBatchDeletion`
 *     already passed.
 */
export abstract class BatchDeletableService {
  abstract validateForBatchDeletion(ids: string[]): Promise<ValidationResult>;
  abstract executeInTransaction(ids: string[]): Promise<number>;
}