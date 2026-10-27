import { BadRequestException } from '@nestjs/common';

/** Preserve the decoded header verbatim, including whitespace. */
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200)
    throw new BadRequestException();
  return value;
}
