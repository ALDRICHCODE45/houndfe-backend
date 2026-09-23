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

  const prisma = { promotion: { findFirst } } as unknown as PrismaService;

  return { prisma, findFirst };
}

function promotionRow(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: PROMOTION_ID,
    tenantId: TENANT_ID,
    title: TITLE,
    consumedProductUnits: 0,
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
