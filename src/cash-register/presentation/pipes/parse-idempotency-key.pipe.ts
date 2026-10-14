/**
 * ParseIdempotencyKeyPipe — cash-register presentation (T3/S8).
 *
 * Every command route requires an `Idempotency-Key` header so duplicate money
 * operations replay to the same result instead of inserting new movements.
 * Rules, mirrored from the chatbot-api pipe so the whole API speaks one
 * idempotency language:
 *   - missing / non-string / empty after trim → 400 INVALID_IDEMPOTENCY_KEY
 *   - length > 200 (after trim)               → 400 INVALID_IDEMPOTENCY_KEY
 *   - otherwise                               → the trimmed key
 *
 * The pipe normalizes (trims) and bounds the key BEFORE the controller hands
 * it to the application, and throws `InvalidArgumentError` so the global
 * `DomainExceptionFilter` maps it to 400.
 */
import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

/**
 * Minimal `ArgumentMetadata` subset the pipe needs. Exported so the
 * `IdempotencyKey` decorator can pass a typed shim instead of depending on the
 * full NestJS metadata shape.
 */
export type ArgumentMetadataShim = Pick<ArgumentMetadata, 'type'>;

/** Maximum idempotency-key length in UTF-16 code units. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** Stable error code surfaced by the domain exception filter. */
export const INVALID_IDEMPOTENCY_KEY_CODE = 'INVALID_IDEMPOTENCY_KEY';

@Injectable()
export class ParseIdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    // Metadata is unused today; referenced so the `PipeTransform` signature is
    // implemented without a `void`-discard workaround flagged by the linter.
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
