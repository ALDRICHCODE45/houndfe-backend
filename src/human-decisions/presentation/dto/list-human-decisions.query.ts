/**
 * HD-04b2 — ListHumanDecisionsQueryDto, the transport contract for
 * `GET /human-decisions`.
 *
 * Approved design (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`, and
 * the FE-confirmed query string
 * `?status=PENDING&page=1&limit=20&search=...&sortBy=createdAt&sortOrder=asc`.
 *
 * Scope: STRUCTURAL transport validation only.
 *   - `status` is REQUIRED and pinned to the single literal `PENDING`.
 *   - `page` / `limit` are parsed with an explicit bounded parser instead of
 *     `class-transformer`'s `@Type(() => Number)`, which would silently accept
 *     `1e0`, `0x10`, `Infinity`, whitespace-padded strings or unsafe integers.
 *   - `limit` is restricted to the approved `20 | 50` set; the omitted default
 *     stays the direct number `20`.
 *   - `sortBy` is pinned to `createdAt` and `sortOrder` to `asc` (the
 *     repository adds the stable `createdAt,id` tiebreak in HD-04b3).
 *   - `search` is optional; when supplied it is NFC-normalized,
 *     whitespace-collapsed and trimmed, bounded at 100 UTF-16 code units, and
 *     an explicitly supplied empty/blank value or any C0/C1 control character
 *     is rejected.
 *
 * Search wildcards: the DTO performs NO SQL/LIKE escaping and NO wildcard
 * handling; `search` travels verbatim to the repository. On PostgreSQL,
 * Prisma `contains` (`mode: 'insensitive'`) maps to `LIKE`/`ILIKE`, where
 * `%`, `_` and the escape character retain wildcard meaning, so
 * parameterization alone does NOT make the term literal. HD-04b3 (repository)
 * MUST escape `%`, `_` and `\` before building the filter for a literal
 * substring search; this DTO intentionally forwards the raw term and makes no
 * such guarantee.
 *
 * No PII/authority fields exist here: `tenantId`, the reviewer identity and
 * every customer field are intentionally ABSENT, so the global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true,
 * transform: true })` (`src/main.ts`) rejects any extra key instead of
 * silently stripping it.
 *
 * Page bound: the only upper bound is a technical safe-skip cap, NOT a
 * product pagination policy. Prisma/PostgreSQL accepts the `skip` argument as
 * a signed 32-bit integer, so `HUMAN_DECISIONS_MAX_PAGE` is the largest
 * 1-based page whose `(page - 1) * HUMAN_DECISIONS_MAX_LIMIT` still fits
 * `HUMAN_DECISIONS_PRISMA_MAX_SKIP` (`2^31 - 1`). The repository slice
 * (HD-04b3) receives a page it can pass to `skip` without an out-of-range
 * argument.
 *
 * HTTP safety is NOT guaranteed by this DTO alone: `main.ts`'s global
 * `ValidationPipe` exceptionFactory can serialize `ValidationError` objects
 * (which carry `value`/`target`). The HD-04d controller MUST apply the
 * already-implemented `HumanDecisionHttpFilter` and separately prove
 * sanitized, value-free HTTP responses. This slice reports that as an
 * explicit blocker and does not attempt to solve it here.
 */
import 'reflect-metadata';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** The only status accepted by `GET /human-decisions` in RESTOCK v1. */
export const HUMAN_DECISIONS_STATUS = 'PENDING';

/** The only supported list sort field (repository adds the `id` tiebreak). */
export const HUMAN_DECISIONS_SORT_BY = 'createdAt';

/** The only supported sort direction for the stable review queue. */
export const HUMAN_DECISIONS_SORT_ORDER = 'asc';

/** Whitelisted page sizes. */
export const HUMAN_DECISIONS_LIMIT_VALUES = [20, 50] as const;

/** Default 1-based page index when `page` is omitted. */
export const HUMAN_DECISIONS_DEFAULT_PAGE = 1;

/** Default page size when `limit` is omitted. */
export const HUMAN_DECISIONS_DEFAULT_LIMIT = 20;

/** Largest whitelisted page size, used for the safe-skip bound. */
export const HUMAN_DECISIONS_MAX_LIMIT = Math.max(
  ...HUMAN_DECISIONS_LIMIT_VALUES,
);

/**
 * Prisma/PostgreSQL accepts the `skip` pagination argument as a signed 32-bit
 * integer, so any computed offset must stay within `2^31 - 1`.
 */
export const HUMAN_DECISIONS_PRISMA_MAX_SKIP = 2_147_483_647;

/**
 * Technical safe-skip cap: the largest 1-based page whose
 * `(page - 1) * HUMAN_DECISIONS_MAX_LIMIT` stays within
 * `HUMAN_DECISIONS_PRISMA_MAX_SKIP`. This is a transport/DB argument bound,
 * never a product pagination policy.
 */
export const HUMAN_DECISIONS_MAX_PAGE =
  Math.floor(HUMAN_DECISIONS_PRISMA_MAX_SKIP / HUMAN_DECISIONS_MAX_LIMIT) + 1;

/** Maximum `search` length in UTF-16 code units. */
export const HUMAN_DECISIONS_SEARCH_MAX_LENGTH = 100;

/**
 * Strict decimal-integer grammar: either a single `0`, or a non-zero leading
 * digit followed by digits. Rejects `01`, `+1`, `-1`, `1.0`, `1e0`, `0x10`,
 * whitespace, `Infinity`, `NaN` and the empty string.
 */
const STRICT_DECIMAL_INTEGER = /^(?:0|[1-9]\d*)$/;

/** Runs of Unicode whitespace (spaces, tabs, NBSP, line separators, ...). */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Sentinel returned by the strict parsers for input they cannot convert. It is
 * deliberately neither a string nor a number, so the `@IsInt` / `@IsString`
 * decorators reject it instead of a malformed value leaking into the DTO.
 */
const INVALID_CONSTRAINT_VALUE = Symbol('invalid-query-value');
type InvalidConstraintValue = typeof INVALID_CONSTRAINT_VALUE;
/** Result of the strict integer parser: a number or the invalid sentinel. */
type ParsedInteger = number | InvalidConstraintValue;
/** Result of the search normalizer: a normalized string or the sentinel. */
type NormalizedSearch = string | InvalidConstraintValue;

/**
 * True when the string contains a C0/C1 control character (HD-02a policy:
 * tab, newline, NUL, DEL, and the 0x7f-0x9f range).
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a transport number strictly. A direct number is returned untouched so
 * the `@IsInt` / bounds decorators judge it; a string must match the strict
 * decimal-integer grammar AND convert to a safe integer. Anything else
 * (arrays, objects, `1e0`, `01`, `-1`, `1.0`, whitespace, unsafe integers)
 * yields the invalid sentinel so class-validator rejects it.
 */
function parseStrictDecimalInteger(value: unknown): ParsedInteger {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string' || !STRICT_DECIMAL_INTEGER.test(value)) {
    return INVALID_CONSTRAINT_VALUE;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : INVALID_CONSTRAINT_VALUE;
}

/**
 * NFC-normalize, collapse whitespace runs and trim. A value carrying a C0/C1
 * control character is returned untouched so `@NoControlCharacters()` rejects
 * it BEFORE whitespace collapsing could hide a tab/newline as a space; a
 * non-string value yields the invalid sentinel so `@IsString` rejects it.
 */
function normalizeSearch(value: unknown): NormalizedSearch {
  if (typeof value !== 'string') {
    return INVALID_CONSTRAINT_VALUE;
  }
  const decomposed = value.normalize('NFC');
  if (hasControlCharacter(decomposed)) {
    return value;
  }
  return decomposed.replace(WHITESPACE_RUN, ' ').trim();
}

/** Reject any C0/C1 control character in the decorated string property. */
@ValidatorConstraint({ name: 'noControlCharacters', async: false })
class NoControlCharactersConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || !hasControlCharacter(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must not contain control characters`;
  }
}

/**
 * Bound a string by UTF-16 code units (`value.length`). class-validator's
 * `@MaxLength` counts Unicode code points, so it would accept 51 astral
 * emoji (102 UTF-16 units) under a 100 limit; the domain canonicalizer bounds
 * by UTF-16, so this mirrors it.
 */
@ValidatorConstraint({ name: 'maxUtf16Length', async: false })
class MaxUtf16LengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const max = Number(args.constraints[0]);
    return typeof value !== 'string' || value.length <= max;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be shorter than or equal to ${Number(
      args.constraints[0],
    )} characters`;
  }
}

/** Property decorator wrapper for the UTF-16 length bound. */
function MaxUtf16Length(max: number): PropertyDecorator {
  return Validate(MaxUtf16LengthConstraint, [max]);
}

/**
 * Skip validation ONLY when the property is omitted (`undefined`). Unlike
 * `@IsOptional`, an explicit `null` is still validated and rejected, so a
 * `null` can never override a field default or reach the repository.
 */
function IsQueryOptional(): PropertyDecorator {
  return ValidateIf((_object, value: unknown) => value !== undefined);
}

export class ListHumanDecisionsQueryDto {
  /** Required single literal; RESTOCK v1 has no other listable status. */
  @IsIn([HUMAN_DECISIONS_STATUS])
  status!: typeof HUMAN_DECISIONS_STATUS;

  /**
   * 1-based page index. Strictly parsed; omitted keeps the direct numeric
   * default `1`. The safe-skip cap keeps `(page - 1) * limit` within the
   * Prisma/PostgreSQL INT32 `skip` range.
   */
  @IsQueryOptional()
  @Transform(({ value }) => parseStrictDecimalInteger(value))
  @IsInt()
  @Min(HUMAN_DECISIONS_DEFAULT_PAGE)
  @Max(HUMAN_DECISIONS_MAX_PAGE)
  page: number = HUMAN_DECISIONS_DEFAULT_PAGE;

  /**
   * Page size. Strictly parsed; omitted keeps the direct numeric default `20`;
   * only the whitelisted `20 | 50` set is accepted.
   */
  @IsQueryOptional()
  @Transform(({ value }) => parseStrictDecimalInteger(value))
  @IsInt()
  @IsIn(HUMAN_DECISIONS_LIMIT_VALUES)
  limit: number = HUMAN_DECISIONS_DEFAULT_LIMIT;

  /** Only `createdAt`; the repository adds the `id` tiebreak (HD-04b3). */
  @IsQueryOptional()
  @IsIn([HUMAN_DECISIONS_SORT_BY])
  sortBy: typeof HUMAN_DECISIONS_SORT_BY = HUMAN_DECISIONS_SORT_BY;

  /** Only `asc`; the review queue is oldest-first. */
  @IsQueryOptional()
  @IsIn([HUMAN_DECISIONS_SORT_ORDER])
  sortOrder: typeof HUMAN_DECISIONS_SORT_ORDER = HUMAN_DECISIONS_SORT_ORDER;

  /**
   * Optional bounded product-name search. NFC-normalized, whitespace
   * collapsed and trimmed; an explicitly supplied empty/blank value is
   * rejected, as are C0/C1 controls and values longer than 100 UTF-16 units.
   * Forwarded verbatim to the repository (no wildcard escaping).
   */
  @IsQueryOptional()
  @Transform(({ value }) => normalizeSearch(value))
  @IsString()
  @IsNotEmpty()
  @Validate(NoControlCharactersConstraint)
  @MaxUtf16Length(HUMAN_DECISIONS_SEARCH_MAX_LENGTH)
  search?: string;
}
