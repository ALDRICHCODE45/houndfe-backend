/**
 * IdempotencyKey — cash-register presentation param decorator (T3/S8).
 *
 * NestJS's built-in `@Headers(property)` does not accept a pipe the way
 * `@Param` / `@Query` do, so this decorator reads the raw header off the
 * request and runs it through `ParseIdempotencyKeyPipe`. Every command route
 * declares `@IdempotencyKey() key: string` and forwards the normalized key.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  ParseIdempotencyKeyPipe,
  type ArgumentMetadataShim,
} from '../pipes/parse-idempotency-key.pipe';

/** Header name (Express lower-cases incoming header names). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

const ARGUMENT_METADATA_SHIM: ArgumentMetadataShim = { type: 'custom' };

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
    }>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
    const pipe = new ParseIdempotencyKeyPipe();
    return pipe.transform(raw, ARGUMENT_METADATA_SHIM);
  },
);
