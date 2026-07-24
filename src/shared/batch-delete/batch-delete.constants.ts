/**
 * batch-delete.constants — env-driven knobs and error code vocabulary.
 *
 * `BATCH_DELETE_MAX_SIZE` is read once at import time. Tests that need
 * a different boundary should patch this constant BEFORE importing
 * the DTO. Production callers tune it via `BATCH_DELETE_MAX_SIZE` env
 * (e.g. containerized deploys that want a smaller guardrail).
 */
export const BATCH_DELETE_MAX_SIZE = Number(
  process.env.BATCH_DELETE_MAX_SIZE ?? 100,
);

export const BATCH_DELETE_VALIDATION_ERROR = 'BATCH_DELETE_VALIDATION_ERROR';
export const BATCH_DELETE_FK_CONSTRAINT = 'BATCH_DELETE_FK_CONSTRAINT';
export const BATCH_DELETE_NOT_FOUND = 'BATCH_DELETE_NOT_FOUND';
export const PROMOTION_REFERENCED_BY_SALE = 'PROMOTION_REFERENCED_BY_SALE';