import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Lowercase alphanumeric, bounded length: covers Prisma `cuid()` (v1, 25
 * chars) and cuid2 (24 chars by default) while rejecting UUIDs, separators,
 * whitespace and oversized input.
 */
export const CUID_PATTERN = /^[a-z0-9]{20,32}$/;

export const isCuid = (value: unknown): value is string =>
  typeof value === 'string' && CUID_PATTERN.test(value);

/**
 * Route-param guard for `@default(cuid())` model ids — the cuid counterpart of
 * Nest's `ParseUUIDPipe`, with the same 400 error body shape.
 */
@Injectable()
export class ParseCuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isCuid(value)) {
      throw new BadRequestException('Validation failed (cuid is expected)');
    }
    return value;
  }
}
