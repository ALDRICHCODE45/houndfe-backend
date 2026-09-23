/**
 * ADAPTER UNIT SPEC: PrismaPromotionAlertLookupRepository.findTitle —
 * pca-3b4a (inert promotion alert lookup).
 *
 * The later near-capacity alert email (`pca-3b4b`) needs exactly one
 * field from the promotion aggregate: its display title. This spec
 * proves three independent things before that consumer exists:
 *
 *   1. STRUCTURAL — the exact Prisma call is
 *      `{ where: { id, tenantId }, select: { title: true } }`. Both
 *      tenant columns are explicit (the port's only tenant authority)
 *      and nothing else is hydrated.
 *   2. BEHAVIORAL — a known promotion resolves to its title string, an
 *      unknown id and a promotion owned by ANOTHER tenant both resolve
 *      to `null`. The notification flow treats `null` as a soft skip.
 *   3. LIGHTWEIGHT — the in-memory Prisma double is PROJECTION-DRIVEN
 *      and honors `select`/`include`, so swapping the title-only select
 *      for an `include` (or a wider projection) breaks the resolved
 *      title assertions; a mock returning whole rows would hide that
 *      regression.
 *
 * pca-3c4a adds a SECOND method to the same port: `findFreshExpiryTitle`.
 * The expiration email (`pca-3c4b`) must not render a title for a promotion
 * whose effective end date changed, was manually ended, has not started, or
 * already expired AFTER the atomic claim hashed `endDateFingerprint`. Both
 * facts — the title and the freshness evidence — must come from ONE
 * tenant-qualified row read: a boolean freshness read followed by a second
 * title lookup would reopen the edit race this method exists to close.
 *
 * Scope note: this proves source-level, in-memory behavior only. No
 * PostgreSQL row-level filtering, HTTP path, Inngest runtime, or real
 * email delivery is exercised or claimed here.
 */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaPromotionAlertLookupRepository } from './prisma-promotion-alert-lookup.repository';
import { PROMOTION_ALERT_LOOKUP } from '../domain/promotion-alert-lookup.repository';
import { PromotionsModule } from '../promotions.module';
import type { PrismaService } from '../../shared/prisma/prisma.service';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const PROMOTION_ID = 'promotion-1';
const TITLE = 'Verano 20% off';

/** Promotion row as stored in the double's in-memory "table". */
type PromotionRow = {
  id: string;
  tenantId: string;
  title: string;
  consumedProductUnits: number;
  // pca-3c4a freshness evidence for `findFreshExpiryTitle`.
  endDate: Date | null;
  startDate: Date | null;
  manuallyEnded: boolean;
};

type PromotionFindFirstArgs = {
  where?: { id?: string; tenantId?: string };
  select?: Record<string, true>;
  include?: Record<string, unknown>;
};

/**
 * Projection-driven Prisma double, faithful to real Prisma semantics: an
 * omitted `where.tenantId` does NOT filter (the first row with the id
 * wins), while a supplied one must match. A field the adapter did not
 * select is NEVER present in the returned row, exactly like a real Prisma
 * `select`, and an `include` returns the unprojected row so relation
 * hydration cannot slip through unnoticed.
 */
function resolveRow(
  rows: readonly PromotionRow[],
  args: PromotionFindFirstArgs,
): unknown {
  const where = args.where ?? {};
  const match = rows.find(
    (candidate) =>
      candidate.id === where.id &&
      (where.tenantId === undefined || candidate.tenantId === where.tenantId),
  );
  if (!match) {
    return null;
  }
  if (args.include) {
    return { ...match };
  }
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(args.select ?? {})) {
    projected[key] = (match as unknown as Record<string, unknown>)[key];
  }
  return projected;
}

function createPrismaDouble(rows: readonly PromotionRow[]) {
  const findFirst = jest.fn(
    (args: PromotionFindFirstArgs): Promise<unknown> =>
      Promise.resolve(resolveRow(rows, args)),
  );
  // Present so a boolean/existence "freshness" read cannot hide behind an
  // untyped partial double: the freshness contract must be satisfied by the
  // ONE projection-driven `findFirst`, never a `count` plus a second lookup.
  const count = jest.fn((): Promise<number> => Promise.resolve(rows.length));

  const prisma = {
    promotion: { findFirst, count },
  } as unknown as PrismaService;

  return { prisma, findFirst, count };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Absolute UTC instant `offsetMs` from "now", the way a stored row carries it. */
function instant(offsetMs: number): Date {
  return new Date(Date.now() + offsetMs);
}

function promotionRow(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: PROMOTION_ID,
    tenantId: TENANT_ID,
    title: TITLE,
    consumedProductUnits: 0,
    endDate: instant(3 * DAY_MS),
    startDate: null,
    manuallyEnded: false,
    ...overrides,
  };
}

describe('PrismaPromotionAlertLookupRepository.findTitle', () => {
  it('queries with an explicitly tenant-qualified where and a title-only projection', async () => {
    const { prisma, findFirst } = createPrismaDouble([promotionRow()]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await repository.findTitle({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROMOTION_ID, tenantId: TENANT_ID },
      select: { title: true },
    });
  });

  it('resolves the promotion display title for the calling tenant', async () => {
    const { prisma } = createPrismaDouble([promotionRow()]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findTitle({ tenantId: TENANT_ID, promotionId: PROMOTION_ID }),
    ).resolves.toBe(TITLE);
  });

  it('returns null when the promotion id does not exist', async () => {
    const { prisma } = createPrismaDouble([promotionRow()]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findTitle({
        tenantId: TENANT_ID,
        promotionId: 'promotion-missing',
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion belongs to another tenant', async () => {
    const { prisma } = createPrismaDouble([
      promotionRow({ tenantId: OTHER_TENANT_ID }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findTitle({ tenantId: TENANT_ID, promotionId: PROMOTION_ID }),
    ).resolves.toBeNull();
  });

  it("selects the calling tenant's row when the same promotion id exists in two tenants", async () => {
    // The foreign row is FIRST, so a query that dropped the tenant
    // predicate would return the other tenant's title instead.
    const { prisma } = createPrismaDouble([
      promotionRow({ tenantId: OTHER_TENANT_ID, title: 'Verano 50% off' }),
      promotionRow({ tenantId: TENANT_ID, title: TITLE }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findTitle({ tenantId: TENANT_ID, promotionId: PROMOTION_ID }),
    ).resolves.toBe(TITLE);
  });

  it.each([
    ['tenantId', { tenantId: '', promotionId: PROMOTION_ID }],
    ['promotionId', { tenantId: TENANT_ID, promotionId: '' }],
  ])(
    'short-circuits an empty %s without querying Prisma',
    async (_field, input) => {
      const { prisma, findFirst } = createPrismaDouble([promotionRow()]);
      const repository = new PrismaPromotionAlertLookupRepository(prisma);

      await expect(repository.findTitle(input)).resolves.toBeNull();
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});

describe('PromotionsModule — inert lookup registration (pca-3b4a)', () => {
  it('registers the lookup provider and exports its token for the top-level registrar', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PromotionsModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PromotionsModule,
    ) as unknown[];

    expect(providers).toContainEqual({
      provide: PROMOTION_ALERT_LOOKUP,
      useClass: PrismaPromotionAlertLookupRepository,
    });
    expect(exports).toContain(PROMOTION_ALERT_LOOKUP);
  });
});

/**
 * pca-3c4a — one-read freshness gate for the expiration email.
 *
 * `findFreshExpiryTitle` must resolve the title AND prove the title still
 * belongs to the alerted end date from the SAME row read. Every case below
 * pairs a title that WOULD resolve with the single freshness predicate that
 * must nullify it, so a dropped predicate cannot pass silently.
 */
describe('PrismaPromotionAlertLookupRepository.findFreshExpiryTitle', () => {
  it('reads the row once with an explicitly tenant-qualified where and an exact title+freshness projection', async () => {
    const endDate = instant(3 * DAY_MS);
    const { prisma, findFirst, count } = createPrismaDouble([
      promotionRow({ endDate }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await repository.findFreshExpiryTitle({
      tenantId: TENANT_ID,
      promotionId: PROMOTION_ID,
      endDateFingerprint: endDate.toISOString(),
    });

    // Structural: exactly ONE tenant-qualified read, and the projection is
    // exactly the freshness evidence plus the title — no relation hydration.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROMOTION_ID, tenantId: TENANT_ID },
      select: {
        title: true,
        endDate: true,
        startDate: true,
        manuallyEnded: true,
      },
    });
    // Anti-shape: no boolean/existence read exists anywhere in this method.
    expect(count).not.toHaveBeenCalled();
  });

  it('resolves the title when the live endDate fingerprint matches and the promotion is started, live, and not manually ended', async () => {
    const endDate = instant(2 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate, startDate: instant(-1 * DAY_MS) }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBe(TITLE);
  });

  it('resolves the title for a starts-immediately promotion (startDate null)', async () => {
    const endDate = instant(2 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate, startDate: null }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBe(TITLE);
  });

  it('does NOT apply the claim-time 7-day window: a far-future matching end date still resolves', async () => {
    // The window belongs to claim time. Send time only cares that the row is
    // not expired and still carries the alerted end date.
    const endDate = instant(30 * DAY_MS);
    const { prisma } = createPrismaDouble([promotionRow({ endDate })]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBe(TITLE);
  });

  it('returns null when the live end date no longer matches the alerted fingerprint', async () => {
    // Same promotion, edited end date (A -> B) after the alert was claimed for A.
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate: instant(4 * DAY_MS) }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: instant(5 * DAY_MS).toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion was manually ended after the alert was claimed', async () => {
    const endDate = instant(3 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate, manuallyEnded: true }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion has not started yet', async () => {
    const endDate = instant(3 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate, startDate: instant(1 * HOUR_MS) }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion already expired', async () => {
    const endDate = instant(-1 * HOUR_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ endDate, startDate: instant(-2 * DAY_MS) }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion has no end date', async () => {
    const { prisma } = createPrismaDouble([promotionRow({ endDate: null })]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: instant(3 * DAY_MS).toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the promotion id does not exist', async () => {
    const endDate = instant(3 * DAY_MS);
    const { prisma } = createPrismaDouble([promotionRow({ endDate })]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: 'promotion-missing',
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it('returns null for a promotion owned by another tenant, even with a matching fingerprint', async () => {
    const endDate = instant(3 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({ tenantId: OTHER_TENANT_ID, endDate }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it("selects the calling tenant's fresh row when the same promotion id exists in two tenants", async () => {
    const foreignEndDate = instant(6 * DAY_MS);
    const endDate = instant(3 * DAY_MS);
    const { prisma } = createPrismaDouble([
      promotionRow({
        tenantId: OTHER_TENANT_ID,
        title: 'Verano 50% off',
        endDate: foreignEndDate,
      }),
      promotionRow({ endDate }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findFreshExpiryTitle({
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: endDate.toISOString(),
      }),
    ).resolves.toBe(TITLE);
  });

  it.each([
    ['blank', ''],
    ['whitespace-only', '   '],
  ])(
    'returns null for a %s title even when the row is otherwise fresh',
    async (_label, title) => {
      const endDate = instant(3 * DAY_MS);
      const { prisma } = createPrismaDouble([promotionRow({ endDate, title })]);
      const repository = new PrismaPromotionAlertLookupRepository(prisma);

      await expect(
        repository.findFreshExpiryTitle({
          tenantId: TENANT_ID,
          promotionId: PROMOTION_ID,
          endDateFingerprint: endDate.toISOString(),
        }),
      ).resolves.toBeNull();
    },
  );

  it.each([
    [
      'tenantId',
      {
        tenantId: '',
        promotionId: PROMOTION_ID,
        endDateFingerprint: '2026-01-01T00:00:00.000Z',
      },
    ],
    [
      'promotionId',
      {
        tenantId: TENANT_ID,
        promotionId: '',
        endDateFingerprint: '2026-01-01T00:00:00.000Z',
      },
    ],
    [
      'endDateFingerprint',
      {
        tenantId: TENANT_ID,
        promotionId: PROMOTION_ID,
        endDateFingerprint: '',
      },
    ],
  ] as const)(
    'short-circuits an empty %s without querying Prisma',
    async (_field, input) => {
      const { prisma, findFirst } = createPrismaDouble([promotionRow()]);
      const repository = new PrismaPromotionAlertLookupRepository(prisma);

      await expect(repository.findFreshExpiryTitle(input)).resolves.toBeNull();
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});

describe('PrismaPromotionAlertLookupRepository.findTitle — pca-3b4a preservation', () => {
  it('still uses the title-only projection and resolves a title regardless of freshness', async () => {
    // The near-capacity email (`pca-3b4b`) is not end-date sensitive: its
    // contract must survive the pca-3c4a addition untouched.
    const { prisma, findFirst } = createPrismaDouble([
      promotionRow({
        endDate: instant(-2 * DAY_MS),
        startDate: instant(-3 * DAY_MS),
        manuallyEnded: true,
      }),
    ]);
    const repository = new PrismaPromotionAlertLookupRepository(prisma);

    await expect(
      repository.findTitle({ tenantId: TENANT_ID, promotionId: PROMOTION_ID }),
    ).resolves.toBe(TITLE);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROMOTION_ID, tenantId: TENANT_ID },
      select: { title: true },
    });
  });
});
