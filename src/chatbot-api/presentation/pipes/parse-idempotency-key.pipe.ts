/**
 * ParseIdempotencyKeyPipe — Q3 / WU2.
 *
 * Validates the `X-Idempotency-Key` header for `registerBotSale` BEFORE
 * any DB read (atomic acquire pattern requires a guaranteed key — see
 * chatbot-api-foundation/spec.md §"Atomic Sale Registration Idempotency"
 * empty-key scenario, and tasks.md WU2-03).
 *
 * Rules (design.md D9 / spec.md §empty-key scenario):
 *   - missing / empty (after trim) → 400 INVALID_IDEMPOTENCY_KEY
 *   - length > 200                 → 400 INVALID_IDEMPOTENCY_KEY
 *   - otherwise                    → return the trimmed string
 *
 * On rejection, throws `InvalidArgumentError` with code
 * `INVALID_IDEMPOTENCY_KEY`; the global `DomainExceptionFilter` already
 * maps `InvalidArgumentError` to HTTP 400 (see
 * `src/shared/filters/domain-exception.filter.ts`).
 *
 * The 200-char cap mirrors the spec wording and keeps the column index
 * sane — `SaleIdempotency.key` is a `String` field, so the cap is purely
 * a guard against unbounded keys.
 */
import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const INVALID_IDEMPOTENCY_KEY_CODE = 'INVALID_IDEMPOTENCY_KEY';

/**
 * Minimal subset of `ArgumentMetadata` that this pipe needs. Exported so
 * the `IdempotencyKey` custom param decorator (which composes this pipe
 * with a header read) can pass a typed shim without depending on the
 * full NestJS metadata shape — `@Headers(property)` does not accept a
 * pipe second argument, so the decorator has to call `pipe.transform(...)`
 * itself.
 */
export type ArgumentMetadataShim = Pick<ArgumentMetadata, 'type'>;

@Injectable()
export class ParseIdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    // `metadata` is reserved for future use (e.g. min/max-length overrides
    // per route) but the current contract is unconditional. The reference
    // is intentional so TypeScript keeps the `PipeTransform` signature
    // happy without a `void`-discard workaround.
    void metadata;

    if (typeof value !== 'string') {
      throw new InvalidArgumentError(
        'Idempotency key must be a string',
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new InvalidArgumentError(
        'Idempotency key is required and must be non-empty',
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
    }

    if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new InvalidArgumentError(
        `Idempotency key exceeds the maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        INVALID_IDEMPOTENCY_KEY_CODE,
      );
    }

    return trimmed;
  }
}
