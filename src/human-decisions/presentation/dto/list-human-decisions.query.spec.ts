/**
 * HD-04b2 — transport-boundary tests for `ListHumanDecisionsQueryDto`.
 *
 * Mirrors the route transport: the global `ValidationPipe` runs with
 * `whitelist`, `forbidNonWhitelisted` and `transform` (`src/main.ts`), so the
 * spec drives the SAME `plainToInstance` + `validate` pipeline with those
 * options. No DB, no env, no provider.
 *
 * The contract under test (approved design:
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`) is the
 * FE-confirmed `GET /human-decisions?status=PENDING&page=1&limit=20&search=...&
 * sortBy=createdAt&sortOrder=asc`.
 *
 * HTTP-safety caveat (HD-04d, out of scope here): this spec proves the DTO
 * boundary only. It does NOT prove the route is HTTP-safe. `main.ts`'s global
 * `ValidationPipe` exceptionFactory can serialize `ValidationError` objects
 * (which carry `value`/`target`), so the HD-04d controller MUST apply the
 * already-implemented `HumanDecisionHttpFilter` and separately prove
 * no-echo/sanitized HTTP responses. This task reports that as an explicit
 * blocker and does not attempt to solve it here.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  HUMAN_DECISIONS_DEFAULT_LIMIT,
  HUMAN_DECISIONS_DEFAULT_PAGE,
  HUMAN_DECISIONS_LIMIT_VALUES,
  HUMAN_DECISIONS_MAX_LIMIT,
  HUMAN_DECISIONS_MAX_PAGE,
  HUMAN_DECISIONS_PRISMA_MAX_SKIP,
  HUMAN_DECISIONS_SEARCH_MAX_LENGTH,
  HUMAN_DECISIONS_SORT_BY,
  HUMAN_DECISIONS_SORT_ORDER,
  HUMAN_DECISIONS_STATUS,
  ListHumanDecisionsQueryDto,
} from './list-human-decisions.query';

/** Same options `main.ts` applies to the global `ValidationPipe`. */
const VALIDATE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
} as const;

async function validateQuery(input: Record<string, unknown>) {
  const dto = plainToInstance(ListHumanDecisionsQueryDto, input);
  const errors = await validate(dto, VALIDATE_OPTIONS);
  return { dto, errors };
}

function errorProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

function constraintMessages(errors: ValidationError[]): string {
  return errors
    .flatMap((error) => Object.values(error.constraints ?? {}))
    .join(' | ');
}

function baseQuery(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status: HUMAN_DECISIONS_STATUS, ...overrides };
}

describe('ListHumanDecisionsQueryDto (global ValidationPipe contract)', () => {
  it('exposes the approved constants', () => {
    expect(HUMAN_DECISIONS_STATUS).toBe('PENDING');
    expect(HUMAN_DECISIONS_SORT_BY).toBe('createdAt');
    expect(HUMAN_DECISIONS_SORT_ORDER).toBe('asc');
    expect([...HUMAN_DECISIONS_LIMIT_VALUES]).toEqual([20, 50]);
    expect(HUMAN_DECISIONS_DEFAULT_PAGE).toBe(1);
    expect(HUMAN_DECISIONS_DEFAULT_LIMIT).toBe(20);
    expect(HUMAN_DECISIONS_SEARCH_MAX_LENGTH).toBe(100);
  });

  describe('defaults', () => {
    it('applies the numeric/string defaults when only status is supplied', async () => {
      const { dto, errors } = await validateQuery(baseQuery());

      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(HUMAN_DECISIONS_DEFAULT_PAGE);
      expect(typeof dto.page).toBe('number');
      expect(dto.limit).toBe(HUMAN_DECISIONS_DEFAULT_LIMIT);
      expect(typeof dto.limit).toBe('number');
      expect(dto.sortBy).toBe(HUMAN_DECISIONS_SORT_BY);
      expect(dto.sortOrder).toBe(HUMAN_DECISIONS_SORT_ORDER);
      expect(dto.search).toBeUndefined();
      expect(dto.status).toBe(HUMAN_DECISIONS_STATUS);
    });

    it('keeps the direct numeric defaults safe when constructed without input', () => {
      const dto = new ListHumanDecisionsQueryDto();

      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(20);
      expect(Number.isSafeInteger(dto.page)).toBe(true);
      expect(Number.isSafeInteger(dto.limit)).toBe(true);
    });
  });

  describe('explicit null is rejected (validation skips only undefined)', () => {
    it.each(['page', 'limit', 'sortBy', 'sortOrder', 'search'])(
      'rejects an explicit null %s',
      async (field) => {
        const { errors } = await validateQuery(baseQuery({ [field]: null }));

        expect(errorProperties(errors)).toContain(field);
      },
    );

    it('rejects an explicit null status (already required)', async () => {
      const { errors } = await validateQuery({ status: null });

      expect(errorProperties(errors)).toContain('status');
    });

    it('rejects an explicit null on every optional field at once', async () => {
      const { errors } = await validateQuery(
        baseQuery({
          page: null,
          limit: null,
          sortBy: null,
          sortOrder: null,
          search: null,
        }),
      );

      expect(errorProperties(errors)).toEqual(
        expect.arrayContaining([
          'page',
          'limit',
          'sortBy',
          'sortOrder',
          'search',
        ]),
      );
    });

    it('still applies the defaults when the sibling fields are omitted', async () => {
      const { dto, errors } = await validateQuery(baseQuery());

      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(HUMAN_DECISIONS_DEFAULT_PAGE);
      expect(dto.limit).toBe(HUMAN_DECISIONS_DEFAULT_LIMIT);
      expect(dto.sortBy).toBe(HUMAN_DECISIONS_SORT_BY);
      expect(dto.sortOrder).toBe(HUMAN_DECISIONS_SORT_ORDER);
      expect(dto.search).toBeUndefined();
    });
  });

  describe('status (required, only PENDING)', () => {
    it('rejects an omitted status', async () => {
      const { errors } = await validateQuery({});

      expect(errorProperties(errors)).toContain('status');
    });

    it.each([
      'RESOLVED',
      'pending',
      'PENDING ',
      ' PENDING',
      '',
      'ANY',
      0,
      null,
    ])('rejects the status %p', async (status) => {
      const { errors } = await validateQuery({ status });

      expect(errorProperties(errors)).toContain('status');
    });

    it('accepts the exact PENDING literal', async () => {
      const { errors } = await validateQuery(baseQuery());

      expect(errors).toHaveLength(0);
    });
  });

  describe('page (strict decimal integer, INT32 safe-skip cap)', () => {
    it('converts a strict decimal string to a number', async () => {
      const { dto, errors } = await validateQuery(baseQuery({ page: '3' }));

      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(3);
      expect(typeof dto.page).toBe('number');
    });

    it('accepts a direct integer number', async () => {
      const { dto, errors } = await validateQuery(baseQuery({ page: 5 }));

      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(5);
    });

    it('derives the cap from the Prisma/PostgreSQL INT32 skip range', () => {
      expect(HUMAN_DECISIONS_PRISMA_MAX_SKIP).toBe(2_147_483_647);
      expect(HUMAN_DECISIONS_MAX_PAGE).toBe(
        Math.floor(
          HUMAN_DECISIONS_PRISMA_MAX_SKIP / HUMAN_DECISIONS_MAX_LIMIT,
        ) + 1,
      );
    });

    it('caps page so (page - 1) * limit fits INT32 skip at limit=50', async () => {
      const atCap = await validateQuery(
        baseQuery({ page: String(HUMAN_DECISIONS_MAX_PAGE), limit: '50' }),
      );
      expect(atCap.errors).toHaveLength(0);
      expect(atCap.dto.page).toBe(HUMAN_DECISIONS_MAX_PAGE);

      const offset = (atCap.dto.page - 1) * 50;
      expect(offset).toBeLessThanOrEqual(HUMAN_DECISIONS_PRISMA_MAX_SKIP);
      expect(offset + 50).toBeGreaterThan(HUMAN_DECISIONS_PRISMA_MAX_SKIP);

      const aboveCap = await validateQuery(
        baseQuery({ page: String(HUMAN_DECISIONS_MAX_PAGE + 1), limit: '50' }),
      );
      expect(errorProperties(aboveCap.errors)).toContain('page');
    });

    it('stays within the INT32 skip range at limit=20 as well', async () => {
      const atCap = await validateQuery(
        baseQuery({ page: String(HUMAN_DECISIONS_MAX_PAGE), limit: '20' }),
      );
      expect(atCap.errors).toHaveLength(0);
      expect(atCap.dto.page).toBe(HUMAN_DECISIONS_MAX_PAGE);

      const offset = (atCap.dto.page - 1) * 20;
      expect(offset).toBeLessThanOrEqual(HUMAN_DECISIONS_PRISMA_MAX_SKIP);
    });

    it('rejects page 0 and accepts page 1 with the omitted limit default', async () => {
      const zero = await validateQuery(baseQuery({ page: '0' }));
      expect(errorProperties(zero.errors)).toContain('page');

      const one = await validateQuery(baseQuery({ page: '1' }));
      expect(one.errors).toHaveLength(0);
      expect(one.dto.page).toBe(1);
      expect(one.dto.limit).toBe(HUMAN_DECISIONS_DEFAULT_LIMIT);
    });

    it.each([
      '0',
      '-1',
      '1.0',
      '1.5',
      '1e0',
      '01',
      '00',
      '+1',
      ' 1',
      '1 ',
      '',
      'abc',
      '0x10',
      'Infinity',
      'NaN',
      // MAX_SAFE_INTEGER + 2 rounds to a non-safe double.
      '9007199254740993',
      '99999999999999999999',
    ])('rejects the non-canonical page string %p', async (page) => {
      const { errors } = await validateQuery(baseQuery({ page }));

      expect(errorProperties(errors)).toContain('page');
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
      'rejects the invalid direct page number %p',
      async (page) => {
        const { errors } = await validateQuery(baseQuery({ page }));

        expect(errorProperties(errors)).toContain('page');
      },
    );

    it.each([['1', '2'], [], {}, true])(
      'rejects the non-scalar page %p',
      async (page) => {
        const { errors } = await validateQuery(baseQuery({ page }));

        expect(errorProperties(errors)).toContain('page');
      },
    );
  });

  describe('limit (defaults 20, only 20 | 50)', () => {
    it.each([
      ['20', 20],
      ['50', 50],
      [20, 20],
      [50, 50],
    ])('accepts limit %p as %p', async (limit, expected) => {
      const { dto, errors } = await validateQuery(baseQuery({ limit }));

      expect(errors).toHaveLength(0);
      expect(dto.limit).toBe(expected);
      expect(typeof dto.limit).toBe('number');
    });

    it.each([
      '10',
      '30',
      '100',
      '0',
      '-20',
      '20.0',
      '50.0',
      '2e1',
      ' 20',
      '20 ',
      '',
      'abc',
      10,
      30,
      20.5,
      ['20'],
      {},
      true,
    ])('rejects the unsupported limit %p', async (limit) => {
      const { errors } = await validateQuery(baseQuery({ limit }));

      expect(errorProperties(errors)).toContain('limit');
    });
  });

  describe('sortBy (defaults createdAt, only createdAt)', () => {
    it('accepts the createdAt literal', async () => {
      const { dto, errors } = await validateQuery(
        baseQuery({ sortBy: 'createdAt' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.sortBy).toBe('createdAt');
    });

    it.each([
      'name',
      'updatedAt',
      'createdat',
      'createdAt ',
      '',
      0,
      ['createdAt'],
    ])('rejects the sortBy %p', async (sortBy) => {
      const { errors } = await validateQuery(baseQuery({ sortBy }));

      expect(errorProperties(errors)).toContain('sortBy');
    });
  });

  describe('sortOrder (defaults asc, only asc)', () => {
    it('accepts the asc literal', async () => {
      const { dto, errors } = await validateQuery(
        baseQuery({ sortOrder: 'asc' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.sortOrder).toBe('asc');
    });

    it.each(['desc', 'ASC', 'asc ', '', 0, ['asc']])(
      'rejects the sortOrder %p',
      async (sortOrder) => {
        const { errors } = await validateQuery(baseQuery({ sortOrder }));

        expect(errorProperties(errors)).toContain('sortOrder');
      },
    );
  });

  describe('search (optional bounded product-name term)', () => {
    it('accepts an omitted search', async () => {
      const { dto, errors } = await validateQuery(baseQuery());

      expect(errors).toHaveLength(0);
      expect(dto.search).toBeUndefined();
    });

    it('NFC-normalizes, collapses whitespace and trims', async () => {
      const { dto, errors } = await validateQuery(
        baseQuery({ search: '  Filtro\u00a0  de   aceite  ' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('Filtro de aceite');
    });

    it('normalizes a decomposed string to NFC', async () => {
      const { dto, errors } = await validateQuery(
        baseQuery({ search: 'Cafe\u0301' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('Caf\u00e9');
    });

    it.each(['', '   ', '\u00a0', '\u2003'])(
      'rejects the explicitly supplied blank search %p',
      async (search) => {
        const { errors } = await validateQuery(baseQuery({ search }));

        expect(errorProperties(errors)).toContain('search');
      },
    );

    it.each([
      'a\u0000b',
      'a\tb',
      'a\nb',
      'a\rb',
      'a\u000bb',
      'a\u001fb',
      'a\u007fb',
      'a\u0085b',
      'a\u009fb',
      '\t',
    ])('rejects the control character search %p', async (search) => {
      const { errors } = await validateQuery(baseQuery({ search }));

      expect(errorProperties(errors)).toContain('search');
    });

    it('accepts a search of exactly the UTF-16 bound and rejects one unit over', async () => {
      const atBound = await validateQuery(
        baseQuery({ search: 'a'.repeat(HUMAN_DECISIONS_SEARCH_MAX_LENGTH) }),
      );
      expect(atBound.errors).toHaveLength(0);
      expect(atBound.dto.search).toHaveLength(
        HUMAN_DECISIONS_SEARCH_MAX_LENGTH,
      );

      const overBound = await validateQuery(
        baseQuery({
          search: 'a'.repeat(HUMAN_DECISIONS_SEARCH_MAX_LENGTH + 1),
        }),
      );
      expect(errorProperties(overBound.errors)).toContain('search');
    });

    it('bounds by UTF-16 code units, not Unicode code points', async () => {
      // 50 emoji = 100 UTF-16 units (50 code points) -> accepted.
      const atBound = await validateQuery(
        baseQuery({ search: '\u{1f600}'.repeat(50) }),
      );
      expect(atBound.errors).toHaveLength(0);

      // 51 emoji = 102 UTF-16 units (still only 51 code points) -> rejected.
      const overBound = await validateQuery(
        baseQuery({ search: '\u{1f600}'.repeat(51) }),
      );
      expect(errorProperties(overBound.errors)).toContain('search');
    });

    it('forwards %, _ and \\ unchanged (HD-04b3 must escape them for a literal substring)', async () => {
      // The DTO only normalizes; it does NOT escape SQL LIKE/ILIKE wildcards.
      // PostgreSQL `LIKE`/`ILIKE` keeps `%`, `_` and the escape character
      // meaningful, so parameterization alone does not make the term literal.
      const { dto, errors } = await validateQuery(
        baseQuery({ search: '50%_off\\' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.search).toBe('50%_off\\');
    });

    it.each([5, true, {}, ['a', 'b']])(
      'rejects the non-string search %p',
      async (search) => {
        const { errors } = await validateQuery(baseQuery({ search }));

        expect(errorProperties(errors)).toContain('search');
      },
    );
  });

  describe('unknown query keys (whitelist + forbidNonWhitelisted)', () => {
    it.each([
      'tenantId',
      'customerId',
      'customerPhone',
      'phone',
      'transcript',
      'prompt',
      'providerPayload',
      'source',
      'branchId',
      'role',
      'userId',
      'q',
    ])('rejects the forbidden key %s', async (key) => {
      const { errors } = await validateQuery(
        baseQuery({ [key]: 'not-allowed' }),
      );

      expect(errorProperties(errors)).toContain(key);
    });

    it('does not expose a PII property on the DTO instance', () => {
      const dto = new ListHumanDecisionsQueryDto();

      expect(Object.prototype.hasOwnProperty.call(dto, 'customerPhone')).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(dto, 'transcript')).toBe(
        false,
      );
    });
  });

  describe('no reflected PII', () => {
    const SECRET = 'PII-secret-13800138000';

    it.each([
      ['status', { status: SECRET }],
      ['page', { page: `${SECRET}` }],
      ['limit', { limit: `${SECRET}` }],
      ['sortBy', { sortBy: SECRET }],
      ['sortOrder', { sortOrder: SECRET }],
      ['search-control', { search: `\u0000${SECRET}` }],
      ['search-oversize', { search: 'x'.repeat(101) + SECRET }],
    ])('never echoes the submitted value for %s', async (_label, override) => {
      const { errors } = await validateQuery(baseQuery(override));

      expect(constraintMessages(errors)).not.toContain(SECRET);
    });
  });

  describe('the FE-confirmed endpoint query', () => {
    it('accepts the full query string shape', async () => {
      const { dto, errors } = await validateQuery({
        status: 'PENDING',
        page: '1',
        limit: '20',
        search: 'Filtro',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      expect(errors).toHaveLength(0);
      expect(dto).toMatchObject({
        status: 'PENDING',
        page: 1,
        limit: 20,
        search: 'Filtro',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });
    });
  });
});
