/**
 * IdempotencyKey — Q3 / WU2 custom param decorator.
 *
 * `registerBotSale` needs the validated `X-Idempotency-Key` header
 * BEFORE any DB read so empty / oversized keys are rejected with
 * `INVALID_IDEMPOTENCY_KEY` → 400 (WU2-03, design.md D7/D8). NestJS's
 * built-in `@Headers(property)` parameter decorator does not accept a
 * pipe as a second argument the way `@Param` and `@Query` do, so this
 * decorator composes the two: it reads the raw header value off the
 * Express request and runs it through `ParseIdempotencyKeyPipe`.
 *
 * Why a dedicated decorator (instead of inlining `pipe.transform` in the
 * method body):
 *   - Keeps the controller signature declarative
 *     (`@IdempotencyKey() key: string`).
 *   - Single source of truth for the validation rule; the pipe stays
 *     independently unit-testable in isolation.
 *   - Aligns with NestJS's "pipe runs before handler body" contract —
 *     the throw propagates up through the framework's exception
 *     filter chain, never reaching the service layer.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  ParseIdempotencyKeyPipe,
  type ArgumentMetadataShim,
} from '../pipes/parse-idempotency-key.pipe';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
    }>();
    const raw = request.headers['x-idempotency-key'];
    // The pipe's ArgumentMetadata is only the type parameter; we pass a
    // shim so the pipe can run as if NestJS had invoked it for the param.
    const pipe = new ParseIdempotencyKeyPipe();
    return pipe.transform(raw, ARGUMENT_METADATA_SHIM);
  },
);

// Minimal metadata stub — ParseIdempotencyKeyPipe only relies on the
// `type` field. Kept private to this module so no caller can accidentally
// depend on it.
const ARGUMENT_METADATA_SHIM: ArgumentMetadataShim = { type: 'custom' };
