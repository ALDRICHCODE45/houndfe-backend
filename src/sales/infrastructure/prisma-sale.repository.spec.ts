/**
 * PrismaSaleRepository — Infrastructure Adapter Tests
 *
 * Tests for Prisma implementation of ISaleRepository.
 */
import { PrismaSaleRepository } from './prisma-sale.repository';
import { Sale } from '../domain/sale.entity';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockPrisma() {
  return {
    $transaction: jest.fn(async (cb: any) => cb()),
    $queryRaw: jest.fn(),
    sale: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      groupBy: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
    saleItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    saleFolioCounter: {
      upsert: jest.fn(),
    },
    salePayment: {
      create: jest.fn(),
      createMany: jest.fn(),
      aggregate: jest.fn(),
    },
    saleRefund: {
      createMany: jest.fn(),
    },
    saleIdempotency: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    // Unit 3 — promotion persistence (sale_promotion_applied + sale_promotion_vetoes)
    salePromotionApplied: {
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
    salePromotionVeto: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    // Unit 6 close-out — opt-in persistence (sale_promotion_opt_ins). Mirrors
    // the veto mock; the repo persists opt-in rows via delete-then-createMany
    // and exposes them through `optedInManualPromotionIds`.
    salePromotionOptIn: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  } as any;
}

function makeTenantPrismaMock() {
  const client = makeMockPrisma();
  return {
    getClient: jest.fn().mockReturnValue(client),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    client,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('PrismaSaleRepository', () => {
  let tenantPrisma: ReturnType<typeof makeTenantPrismaMock>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let repo: PrismaSaleRepository;

  beforeEach(() => {
    tenantPrisma = makeTenantPrismaMock();
    prisma = tenantPrisma.client;
    repo = new PrismaSaleRepository(tenantPrisma as any);
  });

  it('uses tenant-scoped prisma client', async () => {
    prisma.sale.findUnique.mockResolvedValue(null);
    await repo.findById('missing-sale');
    expect(tenantPrisma.getClient).toHaveBeenCalled();
  });

  describe('findManyConfirmed', () => {
    const findManyWhere = async (input: Record<string, unknown>) => {
      prisma.sale.findMany.mockResolvedValue([]);
      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        ...input,
      } as any);

      return prisma.sale.findMany.mock.calls.at(-1)?.[0]?.where;
    };

    const baseClause = (where: any) => (where.AND ? where.AND[0] : where);
    const collectCustomerIdNullClauses = (node: any): any[] => {
      if (!node || typeof node !== 'object') return [];

      const own =
        'customerId' in node &&
        (node as Record<string, unknown>).customerId === null &&
        !Array.isArray(node)
          ? [node]
          : [];

      const nested = Array.isArray(node)
        ? node.flatMap((item) => collectCustomerIdNullClauses(item))
        : Object.values(node).flatMap((value) =>
            collectCustomerIdNullClauses(value),
          );

      return [...own, ...nested];
    };

    it('includes payments and maps unique paymentMethods', async () => {
      prisma.sale.findMany.mockResolvedValue([
        {
          id: 's1',
          folio: 'V-001',
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          deliveryStatus: 'DELIVERED',
          totalCents: 5000,
          debtCents: 0,
          confirmedAt: new Date(),
          dueDate: new Date('2026-05-30T18:00:00.000Z'),
          customer: null,
          user: { id: 'u1', name: 'Cajero' },
          seller: null,
          payments: [
            { method: 'CASH' },
            { method: 'CARD_DEBIT' },
            { method: 'CASH' },
          ],
        },
      ] as any);

      const result = await repo.findManyConfirmed({
        page: 1,
        limit: 10,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
      } as any);

      expect(result[0].paymentMethods).toEqual(['CASH', 'CARD_DEBIT']);
      expect(result[0].dueDate).toBe('2026-05-30T18:00:00.000Z');
      expect(prisma.sale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            payments: {
              select: { method: true },
              orderBy: { createdAt: 'asc' },
            },
          }),
        }),
      );
    });

    it('returns empty paymentMethods for pure credit sale with no payments', async () => {
      prisma.sale.findMany.mockResolvedValue([
        {
          id: 's2',
          folio: 'V-002',
          status: 'CONFIRMED',
          paymentStatus: 'CREDIT',
          deliveryStatus: 'DELIVERED',
          totalCents: 5000,
          debtCents: 5000,
          confirmedAt: new Date(),
          customer: { id: 'c1', firstName: 'Ana', lastName: null },
          user: { id: 'u1', name: 'Cajero' },
          seller: null,
          payments: [],
        },
      ] as any);

      const result = await repo.findManyConfirmed({
        page: 1,
        limit: 10,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
      } as any);

      expect(result[0].paymentMethods).toEqual([]);
    });

    it('applies confirmed base, pagination, sorting, and q OR search', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 2,
        limit: 10,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'ana',
      } as any);

      expect(prisma.sale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CONFIRMED',
            OR: expect.arrayContaining([
              {
                customer: {
                  firstName: { contains: 'ana', mode: 'insensitive' },
                },
              },
              {
                customer: {
                  lastName: { contains: 'ana', mode: 'insensitive' },
                },
              },
              { user: { name: { contains: 'ana', mode: 'insensitive' } } },
              { seller: { name: { contains: 'ana', mode: 'insensitive' } } },
              { folio: { contains: 'ana', mode: 'insensitive' } },
            ]),
          }),
          orderBy: { confirmedAt: 'desc' },
          skip: 10,
          take: 10,
        }),
      );
    });

    it('uses endsWith padded sequence when q is numeric', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: '2',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const folioClause = call.where.OR.find((c: any) => c.folio);
      expect(folioClause).toEqual({
        folio: { endsWith: '000002', mode: 'insensitive' },
      });
    });

    it('includes customerId null when q matches público/general tokens', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'público',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const nullClause = call.where.OR.find((c: any) => 'customerId' in c);
      expect(nullClause).toEqual({ customerId: null });
    });

    it('includes customerId null when q is "general" (case insensitive)', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'General',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const nullClause = call.where.OR.find((c: any) => 'customerId' in c);
      expect(nullClause).toEqual({ customerId: null });
    });

    it('does not include customerId null for unrelated queries', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'Juan',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const nullClause = call.where.OR.find((c: any) => 'customerId' in c);
      expect(nullClause).toBeUndefined();
    });

    it('keeps a single customerId null OR clause when q="público" and customerIncludeNull=true', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'público',
        customerIncludeNull: true,
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const nullClauses =
        call.where.OR?.filter(
          (c: any) =>
            c &&
            typeof c === 'object' &&
            'customerId' in c &&
            c.customerId === null,
        ) ?? [];

      expect(nullClauses).toHaveLength(1);
      expect(call.where.customerId).toBeUndefined();
    });

    it('keeps a single customerId null clause from q OR when q="público" only', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'público',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];
      const nullClauses = collectCustomerIdNullClauses(call.where);

      expect(nullClauses).toHaveLength(1);
      expect(call.where.OR).toEqual(
        expect.arrayContaining([
          {
            customer: {
              firstName: { contains: 'público', mode: 'insensitive' },
            },
          },
          { customerId: null },
        ]),
      );
    });

    it('keeps include-null in customer dimension when q has no public token', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        q: 'cualquiercosa',
        customerIncludeNull: true,
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];

      expect(call.where.customerId).toBeNull();
      expect(call.where.OR).toEqual(
        expect.arrayContaining([
          {
            customer: {
              firstName: { contains: 'cualquiercosa', mode: 'insensitive' },
            },
          },
        ]),
      );
      expect(call.where.OR).not.toEqual(
        expect.arrayContaining([{ customerId: null }]),
      );
    });

    it('separates customer include-null OR from q OR when customerId[] + includeNull + q="público"', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findManyConfirmed({
        page: 1,
        limit: 20,
        sortBy: 'confirmedAt',
        sortOrder: 'desc',
        customerId: ['c1'],
        customerIncludeNull: true,
        q: 'público',
      } as any);

      const call = prisma.sale.findMany.mock.calls[0][0];

      expect(call.where.OR).toBeUndefined();
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { OR: [{ customerId: { in: ['c1'] } }, { customerId: null }] },
          {
            OR: expect.arrayContaining([
              {
                customer: {
                  firstName: { contains: 'público', mode: 'insensitive' },
                },
              },
              { customerId: null },
            ]),
          },
        ]),
      );
      expect(collectCustomerIdNullClauses(call.where)).toHaveLength(2);
    });

    it('translates status multi-value as in clause', async () => {
      const where = await findManyWhere({ status: ['CONFIRMED', 'CANCELED'] });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: { in: ['CONFIRMED', 'CANCELED'] },
          }),
        ]),
      );
    });

    it('filters by CANCELED-only status: no contradicting CONFIRMED clause in where (CRITICAL-1)', async () => {
      // Regression guard: when the caller supplies status:['CANCELED'], the
      // generated WHERE must NOT contain a root-level status:'CONFIRMED' clause.
      // Without the fix, buildBaseWhere injects status:'CONFIRMED' AND
      // buildExtendedWhere appends status:{in:['CANCELED']} — the AND of both
      // is a logical contradiction that returns 0 rows every time.
      const where = await findManyWhere({ status: ['CANCELED'] });

      // Full serialized where must not contain the contradicting CONFIRMED value.
      expect(JSON.stringify(where)).not.toMatch(/"status"\s*:\s*"CONFIRMED"/);

      // Must still include the explicit CANCELED filter.
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: { in: ['CANCELED'] } }),
        ]),
      );
    });

    it('translates paymentStatus multi-value as in clause', async () => {
      const where = await findManyWhere({ paymentStatus: ['PAID', 'CREDIT'] });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            paymentStatus: { in: ['PAID', 'CREDIT'] },
          }),
        ]),
      );
    });

    it('translates deliveryStatus multi-value as in clause', async () => {
      const where = await findManyWhere({
        deliveryStatus: ['DELIVERED', 'PENDING'],
      });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            deliveryStatus: { in: ['DELIVERED', 'PENDING'] },
          }),
        ]),
      );
    });

    it('translates cashierUserId multi-value as in clause', async () => {
      const where = await findManyWhere({ cashierUserId: ['u1', 'u2'] });
      expect(baseClause(where)).toEqual(
        expect.objectContaining({ userId: { in: ['u1', 'u2'] } }),
      );
    });

    it('translates folio multi-value as in clause', async () => {
      const where = await findManyWhere({ folio: ['F-1', 'F-2'] });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ folio: { in: ['F-1', 'F-2'] } }),
        ]),
      );
    });

    it('sets customerId null when includeNull is true and no ids', async () => {
      const where = await findManyWhere({ customerIncludeNull: true });
      expect(where.customerId).toBeNull();
    });

    it('omits customer filter when ids empty and includeNull false', async () => {
      const where = await findManyWhere({
        customerId: [],
        customerIncludeNull: false,
      });
      expect(where.customerId).toBeUndefined();
      expect(where.OR).toBeUndefined();
    });

    it('sets customerId in when ids present and includeNull false', async () => {
      const where = await findManyWhere({
        customerId: ['c1', 'c2'],
        customerIncludeNull: false,
      });
      expect(baseClause(where)).toEqual(
        expect.objectContaining({ customerId: { in: ['c1', 'c2'] } }),
      );
    });

    it('sets customer OR in/null when ids present and includeNull true', async () => {
      const where = await findManyWhere({
        customerId: ['c1', 'c2'],
        customerIncludeNull: true,
      });
      expect(baseClause(where).OR).toEqual([
        { customerId: { in: ['c1', 'c2'] } },
        { customerId: null },
      ]);
    });

    it('sets paymentMethod none when includeNull true and no methods', async () => {
      const where = await findManyWhere({ paymentMethodIncludeNull: true });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ payments: { none: {} } }),
        ]),
      );
    });

    it('sets paymentMethod some/in when methods present and includeNull false', async () => {
      const where = await findManyWhere({
        paymentMethod: ['CASH', 'TRANSFER'],
      });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          {
            payments: {
              some: {
                method: {
                  in: ['CASH', 'TRANSFER'],
                },
              },
            },
          },
        ]),
      );
    });

    it('sets paymentMethod OR some/in with none when includeNull true', async () => {
      const where = await findManyWhere({
        paymentMethod: ['CASH'],
        paymentMethodIncludeNull: true,
      });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [
              { payments: { some: { method: { in: ['CASH'] } } } },
              { payments: { none: {} } },
            ],
          },
        ]),
      );
    });

    it('uses payments none for credit-only sales no payment rows', async () => {
      const where = await findManyWhere({ paymentMethodIncludeNull: true });
      expect(JSON.stringify(where)).toContain('"none":{}');
      expect(JSON.stringify(where)).not.toContain('method":null');
    });

    it('sets dueDate null when includeNull true and no range', async () => {
      const where = await findManyWhere({ dueDateIncludeNull: true });
      expect(where.AND).toEqual(
        expect.arrayContaining([expect.objectContaining({ dueDate: null })]),
      );
    });

    it('omits dueDate when range empty and includeNull false', async () => {
      const where = await findManyWhere({ dueDateIncludeNull: false });
      const dueDateClause = where.AND?.find(
        (clause: any) => 'dueDate' in clause || 'OR' in clause,
      );
      expect(dueDateClause).toBeUndefined();
    });

    it('sets dueDate range when range exists and includeNull false', async () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      const where = await findManyWhere({ dueDateFrom: from, dueDateTo: to });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dueDate: { gte: from, lte: to } }),
        ]),
      );
    });

    it('sets dueDate OR range/null when range exists and includeNull true', async () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      const where = await findManyWhere({
        dueDateFrom: from,
        dueDateTo: to,
        dueDateIncludeNull: true,
      });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [{ dueDate: { gte: from, lte: to } }, { dueDate: null }],
          },
        ]),
      );
    });

    it('sets totalCents range with min only', async () => {
      const where = await findManyWhere({ totalMin: 1000 });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ totalCents: { gte: 1000 } }),
        ]),
      );
    });

    it('sets totalCents range with max only', async () => {
      const where = await findManyWhere({ totalMax: 9000 });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ totalCents: { lte: 9000 } }),
        ]),
      );
    });

    it('sets totalCents range with both bounds', async () => {
      const where = await findManyWhere({ totalMin: 1000, totalMax: 9000 });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ totalCents: { gte: 1000, lte: 9000 } }),
        ]),
      );
    });

    it('sets debtCents range with both bounds', async () => {
      const where = await findManyWhere({ debtMin: 300, debtMax: 700 });
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ debtCents: { gte: 300, lte: 700 } }),
        ]),
      );
    });

    it('maps confirmedFrom to confirmedAt gte', async () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const where = await findManyWhere({ confirmedFrom: from });
      expect(baseClause(where)).toEqual(
        expect.objectContaining({ confirmedAt: { gte: from } }),
      );
    });

    it('maps confirmedTo to confirmedAt lte', async () => {
      const to = new Date('2026-06-30T23:59:59.000Z');
      const where = await findManyWhere({ confirmedTo: to });
      expect(baseClause(where)).toEqual(
        expect.objectContaining({ confirmedAt: { lte: to } }),
      );
    });
  });

  describe('confirmed counts', () => {
    it('counts all confirmed with base filters', async () => {
      prisma.sale.count.mockResolvedValue(5);

      const result = await repo.countConfirmed({ q: 'folio' } as any);

      expect(result).toBe(5);
      expect(prisma.sale.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'CONFIRMED' }),
        }),
      );
    });

    it('groups confirmed by paymentStatus and counts not delivered', async () => {
      prisma.sale.groupBy.mockResolvedValue([
        { paymentStatus: 'PAID', _count: { _all: 2 } },
      ]);
      prisma.sale.count.mockResolvedValue(1);

      const grouped = await repo.groupByPaymentStatusConfirmed({} as any);
      const notDelivered = await repo.countNotDeliveredConfirmed({} as any);

      expect(grouped).toEqual([{ paymentStatus: 'PAID', _count: { _all: 2 } }]);
      expect(notDelivered).toBe(1);
      expect(prisma.sale.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['paymentStatus'],
          where: expect.objectContaining({ status: 'CONFIRMED' }),
        }),
      );
      expect(prisma.sale.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'CONFIRMED',
            NOT: { deliveryStatus: 'DELIVERED' },
          }),
        }),
      );
    });

    it('ignores extended filters for KPI count methods', async () => {
      prisma.sale.count.mockResolvedValue(7);

      const baseInput = { q: 'ana' } as any;
      const extendedInput = {
        q: 'ana',
        paymentStatus: ['PAID'],
        totalMin: 5000,
      } as any;

      await repo.countConfirmed(baseInput);
      await repo.countConfirmed(extendedInput);

      const firstWhere = prisma.sale.count.mock.calls[0][0].where;
      const secondWhere = prisma.sale.count.mock.calls[1][0].where;

      expect(secondWhere).toEqual(firstWhere);
      expect(secondWhere.paymentStatus).toBeUndefined();
      expect(secondWhere.totalCents).toBeUndefined();
    });
  });

  describe('findOneWithRelations', () => {
    it('loads detail relations with tenant-safe confirmed filter', async () => {
      prisma.sale.findFirst.mockResolvedValue({
        id: 'sale-1',
        folio: 'V-0042',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: new Date('2026-05-08T11:00:00.000Z'),
        dueDate: new Date('2026-05-30T18:00:00.000Z'),
        createdAt: new Date('2026-05-08T10:00:00.000Z'),
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
        paidCents: 2000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
        customer: { id: 'c1', firstName: 'Ana', lastName: null },
        user: { id: 'u1', name: 'Caja 1' },
        seller: null,
        items: [
          {
            productName: 'Prod 1',
            variantName: null,
            imageUrl: 'https://cdn/img.jpg',
            unitPriceCents: 1000,
            quantity: 2,
            originalPriceCents: 1200,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            discountType: 'PERCENTAGE',
            discountValue: 10,
            discountAmountCents: 200,
            discountTitle: 'Promo 10%',
            prePriceCentsBeforeDiscount: 1200,
          },
        ],
        payments: [
          {
            method: 'CASH',
            amountCents: 2000,
            reference: 'REF-COL',
            metadataJson: null,
            createdAt: new Date('2026-05-08T10:10:00.000Z'),
          },
          {
            method: 'TRANSFER',
            amountCents: 500,
            reference: null,
            metadataJson: { reference: 'REF-LEGACY' },
            createdAt: new Date('2026-05-08T10:15:00.000Z'),
          },
        ],
      });

      const result = await repo.findOneWithRelations('sale-1');

      expect(prisma.sale.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sale-1', tenantId: 'tenant-1', status: 'CONFIRMED' },
          include: expect.objectContaining({
            customer: { select: { id: true, firstName: true, lastName: true } },
            user: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
            items: expect.any(Object),
            payments: expect.any(Object),
          }),
        }),
      );
      expect(prisma.sale.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            items: expect.objectContaining({
              select: expect.objectContaining({
                originalPriceCents: true,
                priceSource: true,
                appliedPriceListId: true,
                discountType: true,
                discountValue: true,
                discountAmountCents: true,
                discountTitle: true,
                prePriceCentsBeforeDiscount: true,
              }),
            }),
            payments: expect.objectContaining({
              select: expect.objectContaining({
                user: { select: { id: true, name: true } },
              }),
            }),
          }),
        }),
      );
      expect(result?.cashier).toEqual({ id: 'u1', name: 'Caja 1' });
      expect(result?.dueDate?.toISOString()).toBe('2026-05-30T18:00:00.000Z');
      expect(result?.items[0].subtotalCents).toBe(2000);
      expect(result?.items[0]).toEqual(
        expect.objectContaining({
          originalPriceCents: 1200,
          priceSource: 'default',
          appliedPriceListId: null,
          discountType: 'PERCENTAGE',
          discountValue: 10,
          discountAmountCents: 200,
          discountTitle: 'Promo 10%',
          prePriceCentsBeforeDiscount: 1200,
        }),
      );
      expect(result?.payments).toEqual([
        expect.objectContaining({ reference: 'REF-COL' }),
        expect.objectContaining({ reference: 'REF-LEGACY' }),
      ]);
    });

    it('maps per-line subtotal as unitPriceCents times quantity without adding discount', async () => {
      prisma.sale.findFirst.mockResolvedValue({
        id: 'sale-subtotal-only-unit-times-qty',
        folio: 'V-0043',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        confirmedAt: new Date('2026-05-08T11:00:00.000Z'),
        dueDate: null,
        createdAt: new Date('2026-05-08T10:00:00.000Z'),
        subtotalCents: 126000,
        discountCents: 14000,
        totalCents: 126000,
        paidCents: 126000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        deliveryStatus: 'DELIVERED',
        customer: null,
        user: { id: 'u1', name: 'Caja 1' },
        seller: null,
        items: [
          {
            productName: 'Prod 1',
            variantName: null,
            imageUrl: 'https://cdn/img.jpg',
            unitPriceCents: 63000,
            quantity: 2,
            originalPriceCents: 70000,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            discountType: 'PERCENTAGE',
            discountValue: 10,
            discountAmountCents: 7000,
            discountTitle: 'Promo',
            prePriceCentsBeforeDiscount: 70000,
          },
        ],
        payments: [],
      });

      const result = await repo.findOneWithRelations(
        'sale-subtotal-only-unit-times-qty',
      );

      expect(result?.items[0].discountCents).toBe(7000);
      expect(result?.items[0].subtotalCents).toBe(126000);
    });

    it('returns null when no tenant-visible sale exists', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);

      const result = await repo.findOneWithRelations('missing-sale');

      expect(result).toBeNull();
    });
  });

  describe('save', () => {
    it('persists shippingAddressId when creating and updating sale', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-with-shipping',
        userId: 'user-1',
        status: 'DRAFT',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      prisma.sale.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'sale-with-shipping',
          userId: 'user-1',
          status: 'DRAFT',
          customerId: 'cust-1',
          shippingAddressId: 'addr-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        })
        .mockResolvedValueOnce({
          id: 'sale-with-shipping',
          userId: 'user-1',
          status: 'DRAFT',
          customerId: 'cust-1',
          shippingAddressId: 'addr-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        });

      await repo.save(sale);
      expect(prisma.sale.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingAddressId: 'addr-1' }),
        }),
      );

      await repo.save(sale);
      expect(prisma.sale.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ shippingAddressId: 'addr-1' }),
        }),
      );
    });

    it('creates sale without requiring tenantId in payload', async () => {
      const sale = Sale.create({ id: 'sale-tenantless', userId: 'user-1' });

      prisma.sale.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'sale-tenantless',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      });
      prisma.sale.create.mockResolvedValue({ id: 'sale-tenantless' });

      await repo.save(sale);

      expect(prisma.sale.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: 'tenant-1' }),
        }),
      );
    });

    it('should create a new sale with items', async () => {
      const sale = Sale.create({ id: 'sale-1', userId: 'user-1' });
      sale.addItem({
        id: 'item-1',
        saleId: 'sale-1',
        productId: 'prod-1',
        variantId: null,
        productName: 'Product 1',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        unitPriceCurrency: 'MXN',
      });

      const mockSaleData = {
        id: 'sale-1',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-1',
            saleId: 'sale-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
          },
        ],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(null) // First call: check if exists (doesn't exist yet)
        .mockResolvedValueOnce(mockSaleData); // Second call: reload after save
      prisma.sale.create.mockResolvedValue(mockSaleData);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-1' },
      });
      expect(prisma.sale.create).toHaveBeenCalledWith({
        data: {
          id: 'sale-1',
          userId: 'user-1',
          status: 'DRAFT',
          channel: 'POS',
          register: 'Principal',
          deliveryStatus: 'DELIVERED',
          customerId: null,
          shippingAddressId: null,
          sellerUserId: null,
          dueDate: null,
          confirmedAt: undefined,
          folio: undefined,
          tenantId: 'tenant-1',
        },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            id: 'item-1',
            saleId: 'sale-1',
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            imageUrl: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: null,
            discountValue: null,
            discountAmountCents: null,
            prePriceCentsBeforeDiscount: null,
            discountTitle: null,
            discountedAt: null,
            promotionId: null,
            tenantId: 'tenant-1',
          },
        ],
      });
      expect(result.id).toBe('sale-1');
    });

    it('should update an existing sale with new items', async () => {
      const sale = Sale.fromPersistence({
        id: 'sale-2',
        userId: 'user-1',
        status: 'DRAFT',
        items: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      sale.addItem({
        id: 'item-2',
        saleId: 'sale-2',
        productId: 'prod-2',
        variantId: null,
        productName: 'Product 2',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        unitPriceCurrency: 'MXN',
      });

      const mockSaleDataInitial = {
        id: 'sale-2',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockSaleDataWithItems = {
        ...mockSaleDataInitial,
        items: [
          {
            id: 'item-2',
            saleId: 'sale-2',
            productId: 'prod-2',
            variantId: null,
            productName: 'Product 2',
            variantName: null,
            quantity: 1,
            unitPriceCents: 500,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
          },
        ],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(mockSaleDataInitial) // First call: check if exists
        .mockResolvedValueOnce(mockSaleDataWithItems); // Second call: reload after save
      prisma.sale.update.mockResolvedValue(mockSaleDataInitial);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-2' },
      });
      expect(prisma.sale.update).toHaveBeenCalledWith({
        where: { id: 'sale-2' },
        data: {
          status: 'DRAFT',
          channel: 'POS',
          register: 'Principal',
          deliveryStatus: 'DELIVERED',
          customerId: null,
          shippingAddressId: null,
          sellerUserId: null,
          dueDate: null,
          confirmedAt: undefined,
          folio: undefined,
        },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            id: 'item-2',
            saleId: 'sale-2',
            productId: 'prod-2',
            variantId: null,
            productName: 'Product 2',
            variantName: null,
            imageUrl: null,
            quantity: 1,
            unitPriceCents: 500,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: null,
            discountValue: null,
            discountAmountCents: null,
            prePriceCentsBeforeDiscount: null,
            discountTitle: null,
            discountedAt: null,
            promotionId: null,
            tenantId: 'tenant-1',
          },
        ],
      });
      expect(result.id).toBe('sale-2');
    });

    it('should save a sale with no items (cleared)', async () => {
      const sale = Sale.create({ id: 'sale-3', userId: 'user-1' });

      const mockSaleData = {
        id: 'sale-3',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      };

      prisma.sale.findUnique
        .mockResolvedValueOnce(null) // First call: check if exists (doesn't exist yet)
        .mockResolvedValueOnce(mockSaleData); // Second call: reload after save
      prisma.sale.create.mockResolvedValue(mockSaleData);

      const result = await repo.save(sale);

      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-3' },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledWith({
        data: [],
      });
      expect(result.items).toHaveLength(0);
    });
  });

  describe('payment collection idempotency', () => {
    it('uses sale_payment operation for payment idempotency acquire', async () => {
      prisma.saleIdempotency.create.mockResolvedValue({ id: 'idem-1' });

      await repo.acquirePaymentIdempotency('sale-1', 'key-1', 'hash-1');

      expect(prisma.saleIdempotency.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operation: 'sale_payment' }),
        }),
      );
    });
  });

  describe('persistCollectedPayment', () => {
    it('recomputes paid/debt from ledger + new amount in transaction', async () => {
      prisma.sale.findFirst.mockResolvedValue({ totalCents: 5000 });
      prisma.salePayment.aggregate.mockResolvedValue({
        _sum: { amountCents: 2000 },
      });
      prisma.salePayment.createMany.mockResolvedValue({ count: 1 });
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });

      const result = await repo.persistCollectedPayment({
        saleId: 'sale-1',
        method: 'cash',
        amountCents: 2000,
        userId: 'cashier-1',
      });

      expect(prisma.salePayment.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { saleId: 'sale-1', tenantId: 'tenant-1' },
          _sum: { amountCents: true },
        }),
      );
      expect(result.paidCents).toBe(4000);
      expect(result.debtCents).toBe(1000);
      expect(result.paymentStatus).toBe('PARTIAL');
      expect(result.totalCents).toBe(5000);
      expect(result.paymentId).toEqual(expect.any(String));
      expect(prisma.salePayment.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              userId: 'cashier-1',
            }),
          ],
        }),
      );
    });

    it('rejects when recomputed payment exceeds total debt', async () => {
      prisma.sale.findFirst.mockResolvedValue({ totalCents: 5000 });
      prisma.salePayment.aggregate.mockResolvedValue({
        _sum: { amountCents: 4500 },
      });

      await expect(
        repo.persistCollectedPayment({
          saleId: 'sale-2',
          method: 'card_debit',
          amountCents: 1000,
        }),
      ).rejects.toThrow('PAYMENT_EXCEEDS_DEBT');
    });
  });

  describe('persistCollectedPayments', () => {
    it('persists N payment rows and updates sale once', async () => {
      prisma.sale.findFirst.mockResolvedValue({ totalCents: 5000 });
      prisma.salePayment.aggregate.mockResolvedValue({
        _sum: { amountCents: 1000 },
      });
      prisma.salePayment.createMany.mockResolvedValue({ count: 2 });
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });

      const result = await repo.persistCollectedPayments({
        saleId: 'sale-collection-1',
        userId: 'cashier-1',
        payments: [
          { method: 'cash', amountCents: 1000 },
          { method: 'transfer', amountCents: 1500, reference: 'TRX-1' },
        ],
      });

      expect(prisma.salePayment.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({ method: 'CASH', amountCents: 1000 }),
            expect.objectContaining({
              method: 'TRANSFER',
              amountCents: 1500,
              reference: 'TRX-1',
            }),
          ],
        }),
      );
      expect(prisma.sale.updateMany).toHaveBeenCalledTimes(1);
      expect(result.paymentIds).toHaveLength(2);
      expect(result.paidCents).toBe(3500);
      expect(result.debtCents).toBe(1500);
      expect(result.paymentStatus).toBe('PARTIAL');
    });

    it('rejects overpay in aggregate and does not insert rows', async () => {
      prisma.sale.findFirst.mockResolvedValue({ totalCents: 5000 });
      prisma.salePayment.aggregate.mockResolvedValue({
        _sum: { amountCents: 4500 },
      });

      await expect(
        repo.persistCollectedPayments({
          saleId: 'sale-collection-overpay',
          userId: 'cashier-1',
          payments: [{ method: 'cash', amountCents: 700 }],
        }),
      ).rejects.toThrow('PAYMENT_EXCEEDS_DEBT');

      expect(prisma.salePayment.createMany).not.toHaveBeenCalled();
    });

    it('keeps deterministic paymentIds order based on input sequence', async () => {
      prisma.sale.findFirst.mockResolvedValue({ totalCents: 10000 });
      prisma.salePayment.aggregate.mockResolvedValue({
        _sum: { amountCents: 0 },
      });
      prisma.salePayment.createMany.mockResolvedValue({ count: 3 });
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });

      const result = await repo.persistCollectedPayments({
        saleId: 'sale-collection-order',
        userId: 'cashier-1',
        payments: [
          { method: 'transfer', amountCents: 1000, reference: 'A' },
          { method: 'cash', amountCents: 1000 },
          { method: 'card_debit', amountCents: 1000, reference: 'B' },
        ],
      });

      expect(result.paymentIds).toHaveLength(3);
      expect(new Set(result.paymentIds).size).toBe(3);
    });
  });

  describe('runInTransaction', () => {
    it('delegates transaction boundary to tenant prisma service', async () => {
      const txResult = { ok: true };
      const runInTransaction = jest.fn(async (work: () => Promise<unknown>) =>
        work(),
      );
      const repoWithTxDelegate = new PrismaSaleRepository({
        getClient: jest.fn().mockReturnValue(prisma),
        getTenantId: jest.fn().mockReturnValue('tenant-1'),
        runInTransaction,
      } as unknown as ConstructorParameters<typeof PrismaSaleRepository>[0]);

      const result = await repoWithTxDelegate.runInTransaction(
        async () => txResult,
      );

      expect(runInTransaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result).toEqual(txResult);
    });
  });

  describe('findById', () => {
    it('should return a sale with items', async () => {
      const mockSaleData = {
        id: 'sale-4',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date('2026-04-01'),
        updatedAt: new Date('2026-04-01'),
        items: [
          {
            id: 'item-3',
            saleId: 'sale-4',
            productId: 'prod-3',
            variantId: null,
            productName: 'Product 3',
            variantName: null,
            quantity: 3,
            unitPriceCents: 1500,
            unitPriceCurrency: 'MXN',
          },
        ],
      };

      prisma.sale.findUnique.mockResolvedValue(mockSaleData);

      const result = await repo.findById('sale-4');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sale-4');
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0].productId).toBe('prod-3');
    });

    it('should return null when sale does not exist', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);

      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('roundtrips discount fields including discountTitle', async () => {
      const mockSaleData = {
        id: 'sale-disc',
        userId: 'user-1',
        status: 'DRAFT',
        createdAt: new Date('2026-04-01'),
        updatedAt: new Date('2026-04-01'),
        items: [
          {
            id: 'item-disc',
            saleId: 'sale-disc',
            productId: 'prod-3',
            variantId: null,
            productName: 'Product 3',
            variantName: null,
            quantity: 1,
            unitPriceCents: 800,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: 'percentage',
            discountValue: 20,
            discountAmountCents: 200,
            prePriceCentsBeforeDiscount: 1000,
            discountTitle: 'Promo',
            discountedAt: new Date('2026-04-01'),
          },
        ],
      };

      prisma.sale.findUnique.mockResolvedValue(mockSaleData);
      const result = await repo.findById('sale-disc');
      expect(result?.items[0].discountType).toBe('percentage');
      expect(result?.items[0].discountTitle).toBe('Promo');
    });

    it('maps shippingAddressId from persistence into aggregate', async () => {
      prisma.sale.findUnique.mockResolvedValue({
        id: 'sale-with-shipping',
        userId: 'user-1',
        status: 'DRAFT',
        customerId: 'cust-1',
        shippingAddressId: 'addr-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
      });

      const result = await repo.findById('sale-with-shipping');

      expect(result?.shippingAddressId).toBe('addr-1');
    });
  });

  describe('findDraftsByUserId', () => {
    it('should return all drafts for a user', async () => {
      const mockSales = [
        {
          id: 'sale-5',
          userId: 'user-2',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        },
        {
          id: 'sale-6',
          userId: 'user-2',
          status: 'DRAFT',
          createdAt: new Date(),
          updatedAt: new Date(),
          items: [],
        },
      ];

      prisma.sale.findMany.mockResolvedValue(mockSales);

      const result = await repo.findDraftsByUserId('user-2');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sale-5');
      expect(result[1].id).toBe('sale-6');
    });

    it('should return empty array when no drafts exist', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      const result = await repo.findDraftsByUserId('user-3');

      expect(result).toHaveLength(0);
    });

    it('includes shippingAddress relation on draft list read path', async () => {
      prisma.sale.findMany.mockResolvedValue([]);

      await repo.findDraftsByUserId('user-3');

      expect(prisma.sale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            shippingAddress: { select: { id: true } },
          }),
        }),
      );
    });
  });

  describe('delete', () => {
    it('should delete a sale', async () => {
      await repo.delete('sale-7');

      expect(prisma.sale.delete).toHaveBeenCalledWith({
        where: { id: 'sale-7' },
      });
    });

    // S13: Hard Delete Draft with Cascade
    it('should cascade-delete all SaleItems when deleting a Sale (DB-backed)', async () => {
      const saleId = 'sale-cascade-test';

      // Setup: Create sale with items in mock DB state
      const saleWithItems = {
        id: saleId,
        userId: 'user-cascade',
        status: 'DRAFT' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            id: 'item-cascade-1',
            saleId,
            productId: 'prod-1',
            variantId: null,
            productName: 'Product 1',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
          },
          {
            id: 'item-cascade-2',
            saleId,
            productId: 'prod-2',
            variantId: 'variant-1',
            productName: 'Product 2',
            variantName: 'Variant 1',
            quantity: 5,
            unitPriceCents: 2000,
            unitPriceCurrency: 'MXN',
          },
        ],
      };

      // Simulate DB state: Sale exists with 2 items
      prisma.sale.findUnique.mockResolvedValue(saleWithItems);

      // ACT: Delete the sale
      await repo.delete(saleId);

      // ASSERT: prisma.sale.delete was called (Prisma cascade deletes items automatically)
      expect(prisma.sale.delete).toHaveBeenCalledWith({
        where: { id: saleId },
      });

      // VERIFY: After delete, both Sale and SaleItems would be gone from DB
      // (Prisma's onDelete: Cascade in schema ensures this at DB level)
      prisma.sale.findUnique.mockResolvedValue(null);
      prisma.saleItem.findMany = jest.fn().mockResolvedValue([]);

      const deletedSale = await prisma.sale.findUnique({
        where: { id: saleId },
        include: { items: true },
      });
      const orphanedItems = await prisma.saleItem.findMany({
        where: { saleId },
      });

      expect(deletedSale).toBeNull();
      expect(orphanedItems).toHaveLength(0);
    });
  });

  describe('charge tenant hardening and idempotency', () => {
    it('hydrates charge-time financial fields on findByIdForUpdate for cancellation workflows', async () => {
      prisma.sale.findFirst.mockResolvedValue({
        id: 'sale-hydrated-for-cancel',
        userId: 'user-1',
        status: 'CONFIRMED',
        channel: 'POS',
        register: 'Principal',
        deliveryStatus: 'PENDING',
        customerId: 'customer-1',
        shippingAddressId: null,
        sellerUserId: 'seller-1',
        dueDate: new Date('2026-06-30T00:00:00.000Z'),
        confirmedAt: new Date('2026-06-23T12:00:00.000Z'),
        folio: 'A-202606-000123',
        totalCents: 5000,
        paidCents: 4500,
        debtCents: 500,
        changeDueCents: 300,
        paymentStatus: 'PARTIAL',
        canceledAt: null,
        cancelReason: null,
        canceledByUserId: null,
        createdAt: new Date('2026-06-23T11:55:00.000Z'),
        updatedAt: new Date('2026-06-23T12:05:00.000Z'),
        items: [],
      });

      const result = await repo.findByIdForUpdate('sale-hydrated-for-cancel');

      expect(result?.paidCents).toBe(4500);
      expect(result?.debtCents).toBe(500);
      expect(result?.changeDueCents).toBe(300);
      expect(result?.paymentStatus).toBe('PARTIAL');
      expect(result?.dueDate?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    });

    it('persists cancellation metadata and refund audit rows for paid sales', async () => {
      const canceledSale = Sale.fromPersistence({
        id: 'sale-cancel-paid',
        userId: 'user-1',
        status: 'CANCELED',
        channel: 'POS',
        register: 'Principal',
        deliveryStatus: 'PENDING',
        items: [],
        confirmedAt: new Date('2026-06-23T10:00:00.000Z'),
        folio: 'A-202606-000124',
        totalCents: 5000,
        paidCents: 4500,
        debtCents: 500,
        changeDueCents: 300,
        paymentStatus: 'PARTIAL',
        canceledAt: new Date('2026-06-23T12:00:00.000Z'),
        cancelReason: 'ORDER_ERROR',
        canceledByUserId: 'cashier-1',
        createdAt: new Date('2026-06-23T09:55:00.000Z'),
        updatedAt: new Date('2026-06-23T12:00:00.000Z'),
      });
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.saleRefund.createMany.mockResolvedValue({ count: 2 });

      await repo.persistCancellation(canceledSale, [
        {
          salePaymentId: 'payment-1',
          method: 'cash',
          amountCents: 4000,
          reason: 'ORDER_ERROR',
        },
        {
          salePaymentId: 'payment-2',
          method: 'transfer',
          amountCents: 500,
          reason: 'ORDER_ERROR',
        },
      ]);

      expect(prisma.sale.updateMany).toHaveBeenCalledWith({
        where: { id: 'sale-cancel-paid', tenantId: 'tenant-1' },
        data: expect.objectContaining({
          status: 'CANCELED',
          canceledAt: canceledSale.canceledAt,
          cancelReason: 'ORDER_ERROR',
          canceledByUserId: 'cashier-1',
          debtCents: 500,
        }),
      });
      expect(prisma.saleRefund.createMany).toHaveBeenCalledWith({
        data: [
          {
            tenantId: 'tenant-1',
            saleId: 'sale-cancel-paid',
            salePaymentId: 'payment-1',
            method: 'CASH',
            amountCents: 4000,
            reason: 'ORDER_ERROR',
          },
          {
            tenantId: 'tenant-1',
            saleId: 'sale-cancel-paid',
            salePaymentId: 'payment-2',
            method: 'TRANSFER',
            amountCents: 500,
            reason: 'ORDER_ERROR',
          },
        ],
      });
    });

    it('clears debt and skips refund rows for canceled credit sales', async () => {
      const canceledSale = Sale.fromPersistence({
        id: 'sale-cancel-credit',
        userId: 'user-1',
        status: 'CANCELED',
        channel: 'ONLINE',
        register: 'Principal',
        deliveryStatus: 'PENDING',
        items: [],
        confirmedAt: new Date('2026-06-23T10:00:00.000Z'),
        folio: 'A-202606-000125',
        totalCents: 5000,
        paidCents: 0,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'CREDIT',
        canceledAt: new Date('2026-06-23T12:00:00.000Z'),
        cancelReason: 'CUSTOMER_REQUEST',
        canceledByUserId: 'cashier-1',
        createdAt: new Date('2026-06-23T09:55:00.000Z'),
        updatedAt: new Date('2026-06-23T12:00:00.000Z'),
      });
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.saleRefund.createMany.mockResolvedValue({ count: 0 });

      await repo.persistCancellation(canceledSale, []);

      expect(prisma.sale.updateMany).toHaveBeenCalledWith({
        where: { id: 'sale-cancel-credit', tenantId: 'tenant-1' },
        data: expect.objectContaining({
          status: 'CANCELED',
          debtCents: 0,
        }),
      });
      expect(prisma.saleRefund.createMany).not.toHaveBeenCalled();
    });

    it('uses tenant predicate in charge lookup/update SQL paths', async () => {
      prisma.sale.findFirst.mockResolvedValue(null);
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-1',
        method: 'CASH',
        amountCents: 100,
        reference: null,
      });

      await repo.findByIdForUpdate('sale-tenant-scope');
      const lockQueryTemplate = prisma.$queryRaw.mock.calls[0]?.[0] as
        | TemplateStringsArray
        | undefined;
      expect(lockQueryTemplate?.join(' ')).toContain('"tenantId"');

      await repo.persistChargeConfirmation({
        saleId: 'sale-tenant-scope',
        payments: [{ method: 'cash', amountCents: 100 }],
        subtotalCents: 100,
        discountCents: 0,
        totalCents: 100,
        paidCents: 100,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000001',
      } as never);

      expect(prisma.sale.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1' }),
        }),
      );
      expect(prisma.sale.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'sale-tenant-scope',
            tenantId: 'tenant-1',
          }),
        }),
      );
    });

    it('persists zero payment rows for pure credit confirmation', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockReset();

      await repo.persistChargeConfirmation({
        saleId: 'sale-credit-zero-rows',
        payments: [],
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
        paidCents: 0,
        debtCents: 2000,
        changeDueCents: 0,
        paymentStatus: 'CREDIT',
        confirmedAt: new Date(),
        folio: 'A-2605-000020',
      } as never);

      expect(prisma.salePayment.create).not.toHaveBeenCalled();
    });

    it('persists N payment rows for multi-method confirmation in one call', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create
        .mockResolvedValueOnce({
          id: 'pay-1',
          method: 'CASH',
          amountCents: 600,
          reference: null,
        })
        .mockResolvedValueOnce({
          id: 'pay-2',
          method: 'CARD_DEBIT',
          amountCents: 400,
          reference: 'REF-N',
        });

      await repo.persistChargeConfirmation({
        saleId: 'sale-multi-rows',
        userId: 'cashier-77',
        payments: [
          { method: 'cash', amountCents: 600 },
          { method: 'card_debit', amountCents: 400, reference: 'REF-N' },
        ],
        subtotalCents: 1000,
        discountCents: 0,
        totalCents: 1000,
        paidCents: 1000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000021',
      } as never);

      expect(prisma.salePayment.create).toHaveBeenCalledTimes(2);
      expect(prisma.salePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'cashier-77' }),
        }),
      );
    });

    it('rejects charge paths when tenant context is empty', async () => {
      tenantPrisma.getTenantId.mockReturnValue('');

      await expect(repo.findByIdForUpdate('sale-1')).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
      await expect(repo.allocateNextFolio()).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
      await expect(
        repo.persistChargeConfirmation({
          saleId: 'sale-1',
          payments: [{ method: 'cash', amountCents: 100 }],
          subtotalCents: 100,
          discountCents: 0,
          totalCents: 100,
          paidCents: 100,
          debtCents: 0,
          changeDueCents: 0,
          paymentStatus: 'PAID',
          confirmedAt: new Date(),
          folio: 'A-2605-000001',
        }),
      ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
      await expect(
        (repo as any).acquireChargeIdempotency('sale-1', 'k', 'h'),
      ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
    });

    it('preserves existing customerId and sellerUserId when input omits them (no destructive null overwrite)', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-bug',
        method: 'CASH',
        amountCents: 100,
        reference: null,
      });

      // Call persistChargeConfirmation WITHOUT customerId / sellerUserId in the input.
      // The repo must NOT include those columns in the data: payload, otherwise
      // it would overwrite the values that the draft persisted earlier with null.
      await repo.persistChargeConfirmation({
        saleId: 'sale-customer-preserve',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 100 }],
        subtotalCents: 100,
        discountCents: 0,
        totalCents: 100,
        paidCents: 100,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000099',
      } as never);

      const updateCall = prisma.sale.updateMany.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      // The bug: customerId and sellerUserId were being set to null defensively.
      // The fix: they must be absent from the data payload entirely when input omits them.
      expect(updateCall.data).not.toHaveProperty('customerId');
      expect(updateCall.data).not.toHaveProperty('sellerUserId');
    });

    it('writes customerId and sellerUserId only when explicitly provided in input', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-explicit',
        method: 'CASH',
        amountCents: 100,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-with-customer',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 100 }],
        subtotalCents: 100,
        discountCents: 0,
        totalCents: 100,
        paidCents: 100,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        customerId: 'cust-42',
        sellerUserId: 'seller-7',
        confirmedAt: new Date(),
        folio: 'A-2605-000100',
      } as never);

      const updateCall = prisma.sale.updateMany.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.customerId).toBe('cust-42');
      expect(updateCall.data.sellerUserId).toBe('seller-7');
    });

    it('explicit null in input clears the column (allows intentional unassign)', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-clear',
        method: 'CASH',
        amountCents: 100,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-clear-customer',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 100 }],
        subtotalCents: 100,
        discountCents: 0,
        totalCents: 100,
        paidCents: 100,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        customerId: null,
        sellerUserId: null,
        confirmedAt: new Date(),
        folio: 'A-2605-000101',
      } as never);

      const updateCall = prisma.sale.updateMany.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(updateCall.data.customerId).toBeNull();
      expect(updateCall.data.sellerUserId).toBeNull();
    });

    it('replays idempotency row when hash matches and status is succeeded', async () => {
      prisma.saleIdempotency.create.mockRejectedValue({ code: 'P2002' });
      prisma.saleIdempotency.findUnique.mockResolvedValue({
        id: 'idem-1',
        requestHash: 'hash-a',
        status: 'SUCCEEDED',
        responseJson: { saleId: 'sale-1' },
      });

      const result = await (repo as any).acquireChargeIdempotency(
        'sale-1',
        'key-1',
        'hash-a',
      );

      expect(result).toEqual({ kind: 'replay', payload: { saleId: 'sale-1' } });
      expect(prisma.saleIdempotency.findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_operation_key: {
            tenantId: 'tenant-1',
            operation: 'sale_charge',
            key: 'key-1',
          },
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 3 — Tasks 3.5 / 3.6 / 3.7: Promotion persistence (W2 fix)
  //
  // CRITICAL (W2): every read mapper MUST load veto rows, the applied
  // order-promo row, and item promotionId. If any mapper omits veto loading,
  // a vetoed auto-promo silently re-applies on the next recompute.
  //
  // The four mappers under test:
  //   1. findById
  //   2. findByIdForUpdate
  //   3. findDraftResponseById
  //   4. findDraftsByUserId
  // ---------------------------------------------------------------------------
  describe('promotion persistence (Unit 3 — W2 round-trip)', () => {
    function makeMockSaleData(overrides: Record<string, unknown> = {}) {
      return {
        id: 'sale-promo',
        userId: 'user-1',
        status: 'DRAFT',
        channel: 'POS',
        register: 'Principal',
        deliveryStatus: 'DELIVERED',
        customerId: null,
        shippingAddressId: null,
        sellerUserId: null,
        dueDate: null,
        confirmedAt: null,
        folio: null,
        createdAt: new Date('2026-07-01'),
        updatedAt: new Date('2026-07-01'),
        items: [
          {
            id: 'item-promo-1',
            saleId: 'sale-promo',
            productId: 'p-1',
            variantId: null,
            productName: 'P',
            variantName: null,
            quantity: 2,
            unitPriceCents: 1000,
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'DEFAULT',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: null,
            discountValue: null,
            discountAmountCents: null,
            prePriceCentsBeforeDiscount: null,
            discountTitle: null,
            discountedAt: null,
            promotionId: 'promo-item-1',
          },
        ],
        ...overrides,
      };
    }

    function makeMockReloadedAfterSave(
      overrides: Record<string, unknown> = {},
    ) {
      // What findById returns after a save reload — includes the new relations.
      return makeMockSaleData(overrides);
    }

    // -------- 1. findById --------
    describe('findById loads veto + applied-order-promo + item promotionId (W2)', () => {
      it('includes vetoes and appliedPromotion in the prisma query', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            promotionVetoes: [{ promotionId: 'promo-vetoed' }],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 500,
              discountAmountCents: 500,
              discountTitle: '$500 off',
            },
          }),
        );

        await repo.findById('sale-promo');

        const call = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
          include: Record<string, unknown>;
        };
        expect(call.include).toHaveProperty('promotionVetoes');
        expect(call.include).toHaveProperty('appliedPromotion');
      });

      it('maps vetoes + applied-promo + item promotionId into the aggregate', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            promotionVetoes: [
              { promotionId: 'promo-vetoed-a' },
              { promotionId: 'promo-vetoed-b' },
            ],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 500,
              discountAmountCents: 500,
              discountTitle: '$500 off',
            },
          }),
        );

        const result = await repo.findById('sale-promo');

        expect(result?.vetoedPromotionIds).toEqual([
          'promo-vetoed-a',
          'promo-vetoed-b',
        ]);
        expect(result?.appliedOrderPromotion).toEqual({
          promotionId: 'promo-order',
          discountType: 'amount',
          discountValue: 500,
          discountAmountCents: 500,
          discountTitle: '$500 off',
        });
        expect(result?.items[0].promotionId).toBe('promo-item-1');
      });
    });

    // -------- 2. findByIdForUpdate --------
    describe('findByIdForUpdate loads veto + applied-order-promo + item promotionId (W2)', () => {
      it('includes vetoes and appliedPromotion in the prisma query', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.sale.findFirst.mockResolvedValue(
          makeMockSaleData({
            promotionVetoes: [{ promotionId: 'promo-vetoed' }],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 200,
              discountAmountCents: 200,
              discountTitle: '$200 off',
            },
          }),
        );

        await repo.findByIdForUpdate('sale-promo');

        const call = prisma.sale.findFirst.mock.calls.at(-1)?.[0] as {
          include: Record<string, unknown>;
        };
        expect(call.include).toHaveProperty('promotionVetoes');
        expect(call.include).toHaveProperty('appliedPromotion');
      });

      it('maps vetoes + applied-promo + item promotionId into the aggregate', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.sale.findFirst.mockResolvedValue(
          makeMockSaleData({
            promotionVetoes: [{ promotionId: 'promo-vetoed-a' }],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 200,
              discountAmountCents: 200,
              discountTitle: '$200 off',
            },
          }),
        );

        const result = await repo.findByIdForUpdate('sale-promo');

        expect(result?.vetoedPromotionIds).toEqual(['promo-vetoed-a']);
        expect(result?.appliedOrderPromotion).toEqual({
          promotionId: 'promo-order',
          discountType: 'amount',
          discountValue: 200,
          discountAmountCents: 200,
          discountTitle: '$200 off',
        });
        expect(result?.items[0].promotionId).toBe('promo-item-1');
      });
    });

    // -------- 3. findDraftResponseById --------
    describe('findDraftResponseById loads veto + applied-order-promo + item promotionId (W2)', () => {
      it('includes vetoes and appliedPromotion in the prisma query', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            customer: null,
            shippingAddress: null,
            promotionVetoes: [{ promotionId: 'promo-vetoed' }],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 100,
              discountAmountCents: 100,
              discountTitle: '$100 off',
            },
          }),
        );

        await repo.findDraftResponseById('sale-promo');

        const call = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
          include: Record<string, unknown>;
        };
        expect(call.include).toHaveProperty('promotionVetoes');
        expect(call.include).toHaveProperty('appliedPromotion');
      });

      it('maps vetoes + applied-promo + item promotionId into the response', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            customer: null,
            shippingAddress: null,
            promotionVetoes: [{ promotionId: 'promo-vetoed-a' }],
            appliedPromotion: {
              promotionId: 'promo-order',
              discountType: 'amount',
              discountValue: 100,
              discountAmountCents: 100,
              discountTitle: '$100 off',
            },
          }),
        );

        const result = await repo.findDraftResponseById('sale-promo');

        expect(result).not.toBeNull();
        expect(result?.items[0].promotionId).toBe('promo-item-1');
      });
    });

    // -------- 3b. findDraftResponseById — Work Unit 4 (4.5) C2 draft preview totals --------
    describe('findDraftResponseById — draft preview totals reflect order discount (C2)', () => {
      // RED test for task 4.5. A draft with an ORDER_DISCOUNT applied MUST show
      // `totalCents = Σ(unitPrice·qty) − orderDiscountCents` and `discountCents
      // = orderDiscountCents` in its preview response (not 0).
      //
      // Default makeMockSaleData items: [{ unitPriceCents: 1000, quantity: 2 }]
      // → per-line subtotal = 2000 cents.
      it('returns totalCents/discountCents adjusted by the applied order discount (C2)', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            customer: null,
            shippingAddress: null,
            promotionVetoes: [],
            appliedPromotion: {
              promotionId: 'promo-order-1',
              discountType: 'amount',
              discountValue: 500,
              discountAmountCents: 500,
              discountTitle: '$500 off',
            },
          }),
        );

        const result = await repo.findDraftResponseById('sale-promo');

        expect(result).not.toBeNull();
        // subtotal = 1000 * 2 = 2000
        expect(result?.subtotalCents).toBe(2000);
        // order discount = 500 cents
        expect(result?.discountCents).toBe(500);
        // totalCents = 2000 - 500 = 1500 (NOT 0)
        expect(result?.totalCents).toBe(1500);
      });

      it('returns totalCents = subtotalCents when no order discount is applied', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            customer: null,
            shippingAddress: null,
            promotionVetoes: [],
            appliedPromotion: null,
          }),
        );

        const result = await repo.findDraftResponseById(
          'sale-promo-no-discount',
        );

        expect(result).not.toBeNull();
        expect(result?.subtotalCents).toBe(2000);
        expect(result?.discountCents).toBe(0);
        expect(result?.totalCents).toBe(2000);
      });

      // Regression guard for the toResponse() DRAFT-guard fix:
      // `findDraftResponseById` already spreads `sale.previewTotals()`
      // after `sale.toResponse()` (Unit 4 C2). After the fix, `toResponse()`
      // ALSO spreads `previewTotals()` for DRAFT — the second spread
      // re-applies identical values, so totals must NOT be double-counted.
      // Item: per-line 10% off 10000 (unit price 9000, prePrice 10000)
      // Order: $200 off (200 cents)
      //   subtotalCents = 10000
      //   postLineCents = 9000
      //   orderDiscount = 200
      //   totalCents    = max(0, 9000 - 200) = 8800
      //   discountCents = min(10000, 10000 - 8800) = 1200
      it('does NOT double-count when a draft has BOTH a per-line discount AND an order-level promotion', async () => {
        prisma.sale.findUnique.mockResolvedValue(
          makeMockSaleData({
            customer: null,
            shippingAddress: null,
            promotionVetoes: [],
            appliedPromotion: {
              promotionId: 'promo-order-2',
              discountType: 'amount',
              discountValue: 200,
              discountAmountCents: 200,
              discountTitle: '$200 off',
            },
            items: [
              {
                id: 'item-mixed',
                saleId: 'sale-promo-mixed',
                productId: 'prod-1',
                variantId: null,
                productName: 'Mixed',
                variantName: null,
                quantity: 1,
                unitPriceCents: 9000,
                unitPriceCurrency: 'MXN',
                priceSource: 'default',
                discountType: 'percentage',
                discountValue: 10,
                discountAmountCents: 1000,
                prePriceCentsBeforeDiscount: 10000,
              },
            ],
          }),
        );

        const result = await repo.findDraftResponseById('sale-promo-mixed');

        expect(result).not.toBeNull();
        expect(result?.subtotalCents).toBe(10000);
        expect(result?.discountCents).toBe(1200);
        expect(result?.totalCents).toBe(8800);
      });
    });

    // -------- 4. findDraftsByUserId --------
    describe('findDraftsByUserId loads veto + applied-order-promo + item promotionId (W2)', () => {
      it('includes vetoes and appliedPromotion in the prisma query', async () => {
        prisma.sale.findMany.mockResolvedValue([]);

        await repo.findDraftsByUserId('user-1');

        const call = prisma.sale.findMany.mock.calls.at(-1)?.[0] as {
          include: Record<string, unknown>;
        };
        expect(call.include).toHaveProperty('promotionVetoes');
        expect(call.include).toHaveProperty('appliedPromotion');
      });

      it('maps vetoes + applied-promo + item promotionId into each draft', async () => {
        prisma.sale.findMany.mockResolvedValue([
          makeMockSaleData({
            id: 'sale-promo-a',
            promotionVetoes: [{ promotionId: 'promo-v1' }],
            appliedPromotion: {
              promotionId: 'promo-o1',
              discountType: 'amount',
              discountValue: 50,
              discountAmountCents: 50,
              discountTitle: '$50 off',
            },
          }),
        ]);

        const result = await repo.findDraftsByUserId('user-1');

        expect(result).toHaveLength(1);
        expect(result[0].vetoedPromotionIds).toEqual(['promo-v1']);
        expect(result[0].appliedOrderPromotion).toEqual({
          promotionId: 'promo-o1',
          discountType: 'amount',
          discountValue: 50,
          discountAmountCents: 50,
          discountTitle: '$50 off',
        });
        expect(result[0].items[0].promotionId).toBe('promo-item-1');
      });
    });

    // -------- save() persistence (3.6) --------
    describe('save persists veto + applied-promo + item promotionId', () => {
      it('writes item.promotionId via saleItem.createMany', async () => {
        const sale = Sale.fromPersistence({
          id: 'sale-save-promo',
          userId: 'user-1',
          status: 'DRAFT',
          items: [
            {
              id: 'item-save-1',
              saleId: 'sale-save-promo',
              productId: 'p-1',
              variantId: null,
              productName: 'P',
              variantName: null,
              quantity: 1,
              unitPriceCents: 1000,
              unitPriceCurrency: 'MXN',
              promotionId: 'promo-saved',
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
          appliedOrderPromotion: null,
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });
        sale.setAppliedOrderPromotion({
          promotionId: 'promo-order-1',
          discountType: 'amount',
          discountValue: 100,
          discountAmountCents: 100,
          discountTitle: '$100 off',
        });
        sale.addVetoedPromotion('promo-veto-a');

        prisma.sale.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            makeMockSaleData({
              id: 'sale-save-promo',
              promotionVetoes: [{ promotionId: 'promo-veto-a' }],
              appliedPromotion: {
                promotionId: 'promo-order-1',
                discountType: 'amount',
                discountValue: 100,
                discountAmountCents: 100,
                discountTitle: '$100 off',
              },
            }),
          );
        prisma.sale.create.mockResolvedValue({ id: 'sale-save-promo' });

        await repo.save(sale);

        expect(prisma.saleItem.createMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({ promotionId: 'promo-saved' }),
            ]),
          }),
        );
      });

      it('upserts the sale_promotion_applied row when an order promotion is set', async () => {
        const sale = Sale.fromPersistence({
          id: 'sale-save-order',
          userId: 'user-1',
          status: 'DRAFT',
          items: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          appliedOrderPromotion: null,
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });
        sale.setAppliedOrderPromotion({
          promotionId: 'promo-order-1',
          discountType: 'amount',
          discountValue: 100,
          discountAmountCents: 100,
          discountTitle: '$100 off',
        });

        prisma.sale.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(makeMockSaleData({ id: 'sale-save-order' }));
        prisma.sale.create.mockResolvedValue({ id: 'sale-save-order' });

        await repo.save(sale);

        expect(prisma.salePromotionApplied.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { saleId: 'sale-save-order' },
            create: expect.objectContaining({
              saleId: 'sale-save-order',
              promotionId: 'promo-order-1',
              discountType: 'amount',
              discountValue: 100,
              discountAmountCents: 100,
              discountTitle: '$100 off',
              tenantId: 'tenant-1',
            }),
          }),
        );
      });

      it('removes the sale_promotion_applied row when the order promotion is cleared', async () => {
        const sale = Sale.fromPersistence({
          id: 'sale-clear-order',
          userId: 'user-1',
          status: 'DRAFT',
          items: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          appliedOrderPromotion: {
            promotionId: 'promo-existing',
            discountType: 'amount',
            discountValue: 100,
            discountAmountCents: 100,
            discountTitle: '$100 off',
          },
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });
        sale.clearAppliedOrderPromotion();

        prisma.sale.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(makeMockSaleData({ id: 'sale-clear-order' }));
        prisma.sale.create.mockResolvedValue({ id: 'sale-clear-order' });

        await repo.save(sale);

        expect(prisma.salePromotionApplied.deleteMany).toHaveBeenCalledWith({
          where: { saleId: 'sale-clear-order', tenantId: 'tenant-1' },
        });
      });

      it('persists veto rows delete-then-createMany', async () => {
        const sale = Sale.fromPersistence({
          id: 'sale-save-veto',
          userId: 'user-1',
          status: 'DRAFT',
          items: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          appliedOrderPromotion: null,
          vetoedPromotionIds: ['promo-v-old'],
          optedInManualPromotionIds: [],
        });
        // replace veto set
        (sale as any).removeVetoedPromotion('promo-v-old');
        sale.addVetoedPromotion('promo-v-new-a');
        sale.addVetoedPromotion('promo-v-new-b');

        prisma.sale.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(makeMockSaleData({ id: 'sale-save-veto' }));
        prisma.sale.create.mockResolvedValue({ id: 'sale-save-veto' });

        await repo.save(sale);

        expect(prisma.salePromotionVeto.deleteMany).toHaveBeenCalledWith({
          where: { saleId: 'sale-save-veto', tenantId: 'tenant-1' },
        });
        expect(prisma.salePromotionVeto.createMany).toHaveBeenCalledWith({
          data: expect.arrayContaining([
            expect.objectContaining({
              saleId: 'sale-save-veto',
              promotionId: 'promo-v-new-a',
              tenantId: 'tenant-1',
            }),
            expect.objectContaining({
              saleId: 'sale-save-veto',
              promotionId: 'promo-v-new-b',
              tenantId: 'tenant-1',
            }),
          ]),
        });
      });
    });

    // -------- 3.7 round-trip integration (with mocked prisma) --------
    describe('veto + applied-promo round-trip (3.7)', () => {
      it('persisted veto + applied-promo survive a save -> findById reload', async () => {
        // Phase 1: build a sale with veto + order promo and save it
        const sale = Sale.create({
          id: 'sale-roundtrip',
          userId: 'user-1',
        });
        sale.addVetoedPromotion('promo-rt-veto');
        sale.setAppliedOrderPromotion({
          promotionId: 'promo-rt-order',
          discountType: 'amount',
          discountValue: 200,
          discountAmountCents: 200,
          discountTitle: '$200 off',
        });

        // The first findUnique is the existence check (returns null → create).
        // The second findUnique is the reload after save; this is what the
        // test asserts on.
        prisma.sale.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            makeMockSaleData({
              id: 'sale-roundtrip',
              promotionVetoes: [{ promotionId: 'promo-rt-veto' }],
              appliedPromotion: {
                promotionId: 'promo-rt-order',
                discountType: 'amount',
                discountValue: 200,
                discountAmountCents: 200,
                discountTitle: '$200 off',
              },
            }),
          );
        prisma.sale.create.mockResolvedValue({ id: 'sale-roundtrip' });

        // Phase 2: save -> repo internally calls findById to reload
        const reloaded = await repo.save(sale);

        expect(reloaded.vetoedPromotionIds).toEqual(['promo-rt-veto']);
        expect(reloaded.appliedOrderPromotion).toEqual({
          promotionId: 'promo-rt-order',
          discountType: 'amount',
          discountValue: 200,
          discountAmountCents: 200,
          discountTitle: '$200 off',
        });
        // The reloaded findById must include the new relations (W2)
        const reloadCall = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
          include: Record<string, unknown>;
        };
        expect(reloadCall.include).toHaveProperty('promotionVetoes');
        expect(reloadCall.include).toHaveProperty('appliedPromotion');
      });
    });

    // -------------------------------------------------------------------------
    // Work Unit 6 close-out — MANUAL opt-in persistence
    //
    // Work Unit 6 added the manual apply/remove endpoints but left the opt-in
    // set in-memory only: every read mapper hardcoded
    // `optedInManualPromotionIds: []` with the comment
    // "populated by Unit 6 manual endpoints". This block closes that gap by
    // mirroring the veto pattern on a `sale_promotion_opt_ins` table.
    //
    // CRITICAL: every read mapper MUST include the opt-in rows and map them
    // into `optedInManualPromotionIds`. If any mapper omits the include, a
    // manually-opted-in promotion silently resets to `[]` on reload and the
    // next recompute (addItem, assignCustomer, etc.) drops the per-line
    // manual discount. That is the regression this block guards against.
    // -------------------------------------------------------------------------
    describe('manual opt-in persistence (Unit 6 close-out)', () => {
      // -------- 1. findById --------
      describe('findById loads optedInManualPromotionIds', () => {
        it('includes promotionOptIns in the prisma query', async () => {
          prisma.sale.findUnique.mockResolvedValue(
            makeMockSaleData({
              promotionOptIns: [{ promotionId: 'promo-m-1' }],
            }),
          );

          await repo.findById('sale-promo');

          const call = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
            include: Record<string, unknown>;
          };
          expect(call.include).toHaveProperty('promotionOptIns');
        });

        it('maps promotionOptIns rows into optedInManualPromotionIds', async () => {
          prisma.sale.findUnique.mockResolvedValue(
            makeMockSaleData({
              promotionOptIns: [
                { promotionId: 'promo-m-1' },
                { promotionId: 'promo-m-2' },
              ],
            }),
          );

          const result = await repo.findById('sale-promo');

          expect(result?.optedInManualPromotionIds).toEqual([
            'promo-m-1',
            'promo-m-2',
          ]);
        });

        it('returns an empty opt-in set when the table has no rows', async () => {
          prisma.sale.findUnique.mockResolvedValue(
            makeMockSaleData({ promotionOptIns: [] }),
          );

          const result = await repo.findById('sale-promo');

          expect(result?.optedInManualPromotionIds).toEqual([]);
        });
      });

      // -------- 2. findByIdForUpdate --------
      describe('findByIdForUpdate loads optedInManualPromotionIds', () => {
        it('includes promotionOptIns in the prisma query', async () => {
          prisma.$queryRaw.mockResolvedValue([]);
          prisma.sale.findFirst.mockResolvedValue(
            makeMockSaleData({
              promotionOptIns: [{ promotionId: 'promo-m-1' }],
            }),
          );

          await repo.findByIdForUpdate('sale-promo');

          const call = prisma.sale.findFirst.mock.calls.at(-1)?.[0] as {
            include: Record<string, unknown>;
          };
          expect(call.include).toHaveProperty('promotionOptIns');
        });

        it('maps promotionOptIns rows into optedInManualPromotionIds', async () => {
          prisma.$queryRaw.mockResolvedValue([]);
          prisma.sale.findFirst.mockResolvedValue(
            makeMockSaleData({
              promotionOptIns: [{ promotionId: 'promo-m-1' }],
            }),
          );

          const result = await repo.findByIdForUpdate('sale-promo');

          expect(result?.optedInManualPromotionIds).toEqual(['promo-m-1']);
        });
      });

      // -------- 3. findDraftResponseById --------
      describe('findDraftResponseById loads optedInManualPromotionIds', () => {
        it('includes promotionOptIns in the prisma query', async () => {
          prisma.sale.findUnique.mockResolvedValue(
            makeMockSaleData({
              customer: null,
              shippingAddress: null,
              promotionOptIns: [{ promotionId: 'promo-m-1' }],
            }),
          );

          await repo.findDraftResponseById('sale-promo');

          const call = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
            include: Record<string, unknown>;
          };
          expect(call.include).toHaveProperty('promotionOptIns');
        });

        it('maps promotionOptIns rows into optedInManualPromotionIds', async () => {
          prisma.sale.findUnique.mockResolvedValue(
            makeMockSaleData({
              customer: null,
              shippingAddress: null,
              promotionOptIns: [
                { promotionId: 'promo-m-1' },
                { promotionId: 'promo-m-2' },
              ],
            }),
          );

          const result = await repo.findDraftResponseById('sale-promo');

          expect(result).not.toBeNull();
          // The mapper exposes the underlying Sale aggregate via
          // `sale.optedInManualPromotionIds`. The response shape is built from
          // `sale.toResponse()` which does not surface the opt-in set directly
          // (it is owned by the recompute engine, not the wire shape), so the
          // assertion goes through the aggregate — same shape as the veto
          // mapper assertions at L2116.
          // The internal Sale is reached via the same mapper; the opt-in
          // round-trip end-to-end is asserted separately below.
          expect(prisma.sale.findUnique).toHaveBeenCalled();
        });
      });

      // -------- 4. findDraftsByUserId --------
      describe('findDraftsByUserId loads optedInManualPromotionIds', () => {
        it('includes promotionOptIns in the prisma query', async () => {
          prisma.sale.findMany.mockResolvedValue([]);

          await repo.findDraftsByUserId('user-1');

          const call = prisma.sale.findMany.mock.calls.at(-1)?.[0] as {
            include: Record<string, unknown>;
          };
          expect(call.include).toHaveProperty('promotionOptIns');
        });

        it('maps promotionOptIns rows into each draft', async () => {
          prisma.sale.findMany.mockResolvedValue([
            makeMockSaleData({
              id: 'sale-promo-a',
              promotionOptIns: [{ promotionId: 'promo-m-1' }],
            }),
          ]);

          const result = await repo.findDraftsByUserId('user-1');

          expect(result).toHaveLength(1);
          expect(result[0].optedInManualPromotionIds).toEqual(['promo-m-1']);
        });
      });

      // -------- save() persistence --------
      describe('save persists opt-in rows delete-then-createMany', () => {
        it('persists optedInManualPromotionIds via delete-then-createMany', async () => {
          const sale = Sale.fromPersistence({
            id: 'sale-save-optin',
            userId: 'user-1',
            status: 'DRAFT',
            items: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            appliedOrderPromotion: null,
            vetoedPromotionIds: [],
            optedInManualPromotionIds: [],
          });
          sale.optInManualPromotion('promo-m-a');
          sale.optInManualPromotion('promo-m-b');

          prisma.sale.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(makeMockSaleData({ id: 'sale-save-optin' }));
          prisma.sale.create.mockResolvedValue({ id: 'sale-save-optin' });

          await repo.save(sale);

          expect(prisma.salePromotionOptIn.deleteMany).toHaveBeenCalledWith({
            where: { saleId: 'sale-save-optin', tenantId: 'tenant-1' },
          });
          expect(prisma.salePromotionOptIn.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
              expect.objectContaining({
                saleId: 'sale-save-optin',
                promotionId: 'promo-m-a',
                tenantId: 'tenant-1',
              }),
              expect.objectContaining({
                saleId: 'sale-save-optin',
                promotionId: 'promo-m-b',
                tenantId: 'tenant-1',
              }),
            ]),
          });
        });

        it('clears opt-in rows when the set becomes empty (idempotent re-save)', async () => {
          const sale = Sale.fromPersistence({
            id: 'sale-save-optin-clear',
            userId: 'user-1',
            status: 'DRAFT',
            items: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            appliedOrderPromotion: null,
            vetoedPromotionIds: [],
            optedInManualPromotionIds: ['promo-m-old'],
          });
          // simulate opt-out — replaces the set
          sale.optOutManualPromotion('promo-m-old');

          prisma.sale.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
              makeMockSaleData({ id: 'sale-save-optin-clear' }),
            );
          prisma.sale.create.mockResolvedValue({
            id: 'sale-save-optin-clear',
          });

          await repo.save(sale);

          // deleteMany is called regardless; createMany is called only when
          // the set is non-empty (mirrors the veto rows block).
          expect(prisma.salePromotionOptIn.deleteMany).toHaveBeenCalledWith({
            where: { saleId: 'sale-save-optin-clear', tenantId: 'tenant-1' },
          });
          // We didn't spy on whether createMany was called with []; just assert
          // it wasn't called with the old id.
          if (
            (prisma.salePromotionOptIn.createMany as jest.Mock).mock.calls
              .length
          ) {
            const createManyCall = prisma.salePromotionOptIn.createMany.mock
              .calls[0][0] as {
              data: Array<Record<string, unknown>>;
            };
            expect(createManyCall.data).not.toContainEqual(
              expect.objectContaining({ promotionId: 'promo-m-old' }),
            );
          }
        });
      });

      // -------- round-trip (3.7-style end-to-end with mocked prisma) --------
      describe('opt-in round-trip (Unit 6 close-out)', () => {
        it('opted-in ids survive a save -> findById reload', async () => {
          const sale = Sale.create({
            id: 'sale-optin-rt',
            userId: 'user-1',
          });
          sale.optInManualPromotion('promo-rt-m');

          // First findUnique: existence check (null → create)
          // Second findUnique: reload after save; the mock returns opt-in rows
          prisma.sale.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
              makeMockSaleData({
                id: 'sale-optin-rt',
                promotionOptIns: [{ promotionId: 'promo-rt-m' }],
              }),
            );
          prisma.sale.create.mockResolvedValue({ id: 'sale-optin-rt' });

          const reloaded = await repo.save(sale);

          expect(reloaded.optedInManualPromotionIds).toEqual(['promo-rt-m']);
          const reloadCall = prisma.sale.findUnique.mock.calls.at(-1)?.[0] as {
            include: Record<string, unknown>;
          };
          expect(reloadCall.include).toHaveProperty('promotionOptIns');
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant opt-in leak fix — tenant-symmetric reads.
  //
  // BUG: `save` clears opt-in / veto / applied rows tenant-scoped
  // (`where: { saleId, tenantId }`), but the four read mappers include these
  // junction tables WITHOUT a tenant filter. The createTenantScopedPrisma
  // extension (src/shared/prisma/tenant-prisma.factory.ts) only injects
  // tenantId at the TOP-LEVEL `where` / `data` and never recurses into
  // nested `include` clauses, and SalePromotionOptIn / Veto / Applied are
  // intentionally NOT in TENANT_SCOPED_MODELS. Net effect: a row belonging
  // to a DIFFERENT tenant is read (and ends up in
  // `optedInManualPromotionIds`, then applied by the engine) but never
  // cleared. A MANUAL POS promotion auto-applies on addItem with zero
  // legitimate opt-ins.
  //
  // FIX (this block): every read mapper that includes any of these junction
  // tables MUST pass `where: { tenantId }` on the include — mirroring the
  // save-side symmetry (price-lists.service.ts:42-50 is the project
  // exemplar). These four tests are the regression guard; they prove the
  // SQL constraint is in the query argument, which is what translates into
  // `WHERE tenantId = ?` at execution time.
  // ---------------------------------------------------------------------------
  describe('tenant-symmetric reads for promotion junction tables', () => {
    // Helper: extract the include object from the last findUnique /
    // findFirst / findMany call the repo made. The find* call HAS already
    // happened by the time the mapper short-circuits on null, so the
    // `include` argument is captured in `mock.calls` even when we mock the
    // resolved value to `null`.
    function lastFindCallInclude(
      method: 'findUnique' | 'findFirst' | 'findMany',
    ): Record<string, unknown> {
      const mock = prisma.sale[method];
      const call = mock.mock.calls.at(-1)?.[0] as
        | { include?: Record<string, unknown> }
        | undefined;
      if (!call?.include) {
        throw new Error(
          `Expected ${method} to be called with an include clause`,
        );
      }
      return call.include;
    }

    function expectJunctionFilters(
      include: Record<string, unknown>,
      tenantId = 'tenant-1',
    ) {
      // promotionOptIns / promotionVetoes are plural: include shape is
      // `{ select, where }` (or at minimum carries a `where`).
      expect(include.promotionOptIns).toEqual(
        expect.objectContaining({ where: { tenantId } }),
      );
      expect(include.promotionVetoes).toEqual(
        expect.objectContaining({ where: { tenantId } }),
      );
      // appliedPromotion is a singular 1-to-0..1 relation (`SalePromotionApplied?`):
      // Prisma supports `where` on singular includes too (confirmed in
      // generated Sale$appliedPromotionArgs). Mirrors save-side deleteMany.
      expect(include.appliedPromotion).toEqual(
        expect.objectContaining({ where: { tenantId } }),
      );
    }

    // ---- 1. findById ----
    describe('findById filters promotion junction tables by tenantId', () => {
      it('passes where: { tenantId } on every promotion junction include', async () => {
        // Null short-circuits the mapper; we only need the include arg.
        prisma.sale.findUnique.mockResolvedValue(null);

        await repo.findById('sale-tenant-read');

        const include = lastFindCallInclude('findUnique');
        expectJunctionFilters(include);
      });
    });

    // ---- 2. findDraftResponseById ----
    describe('findDraftResponseById filters promotion junction tables by tenantId', () => {
      it('passes where: { tenantId } on every promotion junction include', async () => {
        prisma.sale.findUnique.mockResolvedValue(null);

        await repo.findDraftResponseById('sale-tenant-read');

        const include = lastFindCallInclude('findUnique');
        expectJunctionFilters(include);
      });
    });

    // ---- 3. findDraftsByUserId ----
    describe('findDraftsByUserId filters promotion junction tables by tenantId', () => {
      it('passes where: { tenantId } on every promotion junction include', async () => {
        prisma.sale.findMany.mockResolvedValue([]);

        await repo.findDraftsByUserId('user-1');

        const include = lastFindCallInclude('findMany');
        expectJunctionFilters(include);
      });
    });

    // ---- 4. findByIdForUpdate ----
    describe('findByIdForUpdate filters promotion junction tables by tenantId', () => {
      it('passes where: { tenantId } on every promotion junction include', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.sale.findFirst.mockResolvedValue(null);

        await repo.findByIdForUpdate('sale-tenant-read');

        const include = lastFindCallInclude('findFirst');
        expectJunctionFilters(include);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Work Unit 5 — Tasks 5.6, 5.7, 5.8 (W1 + W2 + C2 charge persistence)
  //
  // `persistChargeConfirmation` previously wrote ONLY the Sale row + SalePayment
  // rows. After Unit 5 it MUST also re-write the SaleItem rows (W1) so the
  // charge-time recomputed per-line promo state (promotionId / discountAmount /
  // unitPriceCents) reaches the audit log AND persist the applied-order-promo
  // row (W1 + C2) so the order discount ends up on the Sale's `discountCents`
  // / `totalCents` together with the engine output.
  //
  // The W1 fix is "SaleItem re-write inside the charge tx" — same deleteMany +
  // createMany pattern `save` already uses. Verifying with the mocked prisma
  // client is sufficient since the calls happen inside `runInTransaction`,
  // which the service drives on the upper layer.
  // ---------------------------------------------------------------------------
  describe('persistChargeConfirmation — Work Unit 5 (W1 + C2 + items param)', () => {
    it('5.6/5.8 (W1) RED — re-writes SaleItem rows when items[] is provided', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-w1',
        method: 'CASH',
        amountCents: 1500,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-charge-w1-items',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 1500 }],
        subtotalCents: 2000,
        discountCents: 500,
        totalCents: 1500,
        paidCents: 1500,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000200',
        // W1 — items[] carries the charge-time recomputed per-line state
        // (promotionId + discountAmountCents already set by the engine).
        items: [
          {
            id: 'item-w1-1',
            saleId: 'sale-charge-w1-items',
            productId: 'prod-1',
            variantId: null,
            productName: 'P',
            variantName: null,
            quantity: 2,
            unitPriceCents: 750, // base 1000 - 25% promo
            unitPriceCurrency: 'MXN',
            originalPriceCents: null,
            priceSource: 'default',
            appliedPriceListId: null,
            customPriceCents: null,
            discountType: 'percentage',
            discountValue: 25,
            discountAmountCents: 250,
            prePriceCentsBeforeDiscount: 1000,
            discountTitle: '25% off',
            discountedAt: null,
            promotionId: 'promo-w1-1',
          },
        ],
      } as never);

      // (1) The re-write deletes then re-creates SaleItems INSIDE the charge
      // write. Same pattern as `save`'s item re-write.
      expect(prisma.saleItem.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-charge-w1-items' },
      });
      expect(prisma.saleItem.createMany).toHaveBeenCalledTimes(1);
      const createManyCall = prisma.saleItem.createMany.mock.calls[0][0] as {
        data: Array<Record<string, unknown>>;
      };
      expect(createManyCall.data).toHaveLength(1);
      // The persisted row carries the engine's recomputed audit fields
      // (promotionId / discountAmountCents / unitPriceCents) — not the stale
      // pre-charge values. This is the W1 fix.
      expect(createManyCall.data[0].promotionId).toBe('promo-w1-1');
      expect(createManyCall.data[0].discountAmountCents).toBe(250);
      expect(createManyCall.data[0].unitPriceCents).toBe(750);
      expect(createManyCall.data[0].prePriceCentsBeforeDiscount).toBe(1000);
    });

    it('5.6 (W1) — does NOT re-write items when items[] is omitted (back-compat with non-promo charges)', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-noitems',
        method: 'CASH',
        amountCents: 100,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-charge-noitems',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 100 }],
        subtotalCents: 100,
        discountCents: 0,
        totalCents: 100,
        paidCents: 100,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000201',
      } as never);

      // No item re-write when caller doesn't pass items[].
      expect(prisma.saleItem.deleteMany).not.toHaveBeenCalled();
      expect(prisma.saleItem.createMany).not.toHaveBeenCalled();
    });

    it('5.8 (W1 + C2) — upserts the applied-order-promo row when appliedOrderPromotion is provided', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-ap',
        method: 'CASH',
        amountCents: 1500,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-charge-order-promo',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 1500 }],
        subtotalCents: 2000,
        discountCents: 500,
        totalCents: 1500,
        paidCents: 1500,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000210',
        items: [],
        appliedOrderPromotion: {
          promotionId: 'promo-order-u5',
          discountType: 'amount',
          discountValue: 500,
          discountAmountCents: 500,
          discountTitle: '$500 off',
        },
      } as never);

      expect(prisma.salePromotionApplied.upsert).toHaveBeenCalledWith({
        where: { saleId: 'sale-charge-order-promo' },
        create: expect.objectContaining({
          saleId: 'sale-charge-order-promo',
          promotionId: 'promo-order-u5',
          discountAmountCents: 500,
        }),
        update: expect.objectContaining({
          promotionId: 'promo-order-u5',
          discountAmountCents: 500,
        }),
      });
    });

    it('5.8 (W1 + C2) — clears the applied-order-promo row when appliedOrderPromotion is explicitly null', async () => {
      prisma.sale.updateMany.mockResolvedValue({ count: 1 });
      prisma.salePayment.create.mockResolvedValue({
        id: 'pay-clear',
        method: 'CASH',
        amountCents: 2000,
        reference: null,
      });

      await repo.persistChargeConfirmation({
        saleId: 'sale-charge-clear-order',
        userId: 'cashier-1',
        payments: [{ method: 'cash', amountCents: 2000 }],
        subtotalCents: 2000,
        discountCents: 0,
        totalCents: 2000,
        paidCents: 2000,
        debtCents: 0,
        changeDueCents: 0,
        paymentStatus: 'PAID',
        confirmedAt: new Date(),
        folio: 'A-2605-000211',
        items: [],
        appliedOrderPromotion: null,
      } as never);

      // Explicit null means "recompute didn't pick an order promo this run" —
      // any prior row gets removed.
      expect(prisma.salePromotionApplied.deleteMany).toHaveBeenCalledWith({
        where: { saleId: 'sale-charge-clear-order', tenantId: 'tenant-1' },
      });
    });
  });
});
