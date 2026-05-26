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
    saleIdempotency: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
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
          expect.objectContaining({ status: { in: ['CONFIRMED'] } }),
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
            discountAmountCents: null,
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
      expect(result?.payments).toEqual([
        expect.objectContaining({ reference: 'REF-COL' }),
        expect.objectContaining({ reference: 'REF-LEGACY' }),
      ]);
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
});
