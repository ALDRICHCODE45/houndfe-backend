import { Product } from './domain/product.entity';
import { ProductsService } from './products.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LIST_A = '550e8400-e29b-41d4-a716-446655440000';
const LIST_B = '660e8400-e29b-41d4-a716-446655440001';
const GENERIC_ERROR = 'Catalog price list selection is invalid';

type Row = Record<string, unknown>;

function createHarness(
  options: {
    boundIds?: string[];
    joinError?: Error;
  } = {},
) {
  const events: string[] = [];
  let transactionOpen = false;
  let committed = { products: [] as Row[], joins: [] as Row[] };
  let working = committed;

  const tx = {
    tenantCatalogPriceList: {
      findMany: jest.fn(() => {
        expect(transactionOpen).toBe(true);
        events.push('binding-query');
        return (options.boundIds ?? []).map((globalPriceListId) => ({
          globalPriceListId,
        }));
      }),
    },
    product: {
      create: jest.fn(({ data }: { data: Row }) => {
        expect(transactionOpen).toBe(true);
        events.push('product-create');
        working.products.push(data);
        return data;
      }),
    },
    productCatalogPriceList: {
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        expect(transactionOpen).toBe(true);
        events.push('join-create');
        if (options.joinError) throw options.joinError;
        working.joins.push(...data);
        return { count: data.length };
      }),
    },
    globalPriceList: {
      findMany: jest.fn(() => {
        expect(transactionOpen).toBe(true);
        events.push('global-list-query');
        return [];
      }),
    },
  };

  const outsideTx = jest.fn(() => {
    throw new Error('delegate used outside transaction');
  });
  const root = {
    tenantCatalogPriceList: { findMany: outsideTx },
    product: { create: outsideTx },
    productCatalogPriceList: { createMany: outsideTx },
    $transaction: jest.fn(
      async <T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => {
        working = {
          products: [...committed.products],
          joins: [...committed.joins],
        };
        transactionOpen = true;
        try {
          const result = await callback(tx);
          committed = working;
          return result;
        } finally {
          transactionOpen = false;
        }
      },
    ),
  };
  const tenantPrisma = {
    getTenantId: jest.fn(() => TENANT_ID),
    getClient: jest.fn(() => root),
  };
  const service = new ProductsService(
    {
      isSkuTaken: jest.fn(() => Promise.resolve(false)),
      isBarcodeTaken: jest.fn(() => Promise.resolve(false)),
    } as never,
    root as never,
    {} as never,
    tenantPrisma as never,
    { assertExists: jest.fn(() => Promise.resolve(undefined)) } as never,
  );
  const buildFullResponse = jest
    .spyOn(
      service as unknown as {
        buildFullResponse(productId: string): Promise<{ id: string }>;
      },
      'buildFullResponse',
    )
    .mockResolvedValue({ id: 'response' });

  return {
    service,
    root,
    tx,
    events,
    outsideTx,
    buildFullResponse,
    committed: () => committed,
  };
}

describe('ProductsService.create catalog allowlist', () => {
  afterEach(() => jest.restoreAllMocks());

  it('normalizes, validates, and inserts a non-empty allowlist in the product transaction', async () => {
    const harness = createHarness({ boundIds: [LIST_A, LIST_B] });
    const productCreate = jest.spyOn(Product, 'create');

    await expect(
      harness.service.create({
        name: 'Catalog product',
        supportedCatalogPriceListIds: [LIST_A.toUpperCase(), LIST_B],
      }),
    ).resolves.toEqual({ id: 'response' });

    expect(productCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedCatalogPriceListIds: [LIST_A, LIST_B],
      }),
    );
    expect(harness.tx.tenantCatalogPriceList.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        globalPriceListId: { in: [LIST_A, LIST_B] },
      },
      select: { globalPriceListId: true },
    });
    expect(harness.events.indexOf('binding-query')).toBeLessThan(
      harness.events.indexOf('product-create'),
    );
    const productId = harness.committed().products[0].id;
    expect(harness.committed().joins).toEqual([
      { tenantId: TENANT_ID, productId, globalPriceListId: LIST_A },
      { tenantId: TENANT_ID, productId, globalPriceListId: LIST_B },
    ]);
    expect(harness.outsideTx).not.toHaveBeenCalled();
  });

  it.each([
    ['omitted', undefined],
    ['empty', []],
  ])(
    'treats an %s allowlist as all-public without binding work',
    async (_label, ids) => {
      const harness = createHarness();
      const productCreate = jest.spyOn(Product, 'create');

      await harness.service.create({
        name: 'All-public product',
        ...(ids === undefined ? {} : { supportedCatalogPriceListIds: ids }),
      });

      expect(productCreate).toHaveBeenCalledWith(
        expect.objectContaining({ supportedCatalogPriceListIds: [] }),
      );
      expect(harness.tx.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
      expect(
        harness.tx.productCatalogPriceList.createMany,
      ).not.toHaveBeenCalled();
      expect(harness.committed().products).toHaveLength(1);
    },
  );

  it.each([
    ['exact', [LIST_A, LIST_A]],
    ['case-variant', [LIST_A, LIST_A.toUpperCase()]],
  ])(
    'rejects %s duplicates before opening a transaction',
    async (_label, ids) => {
      const harness = createHarness();

      await expect(
        harness.service.create({
          name: 'Duplicate product',
          supportedCatalogPriceListIds: ids,
        }),
      ).rejects.toMatchObject({
        name: 'InvalidArgumentError',
        code: 'INVALID_ARGUMENT',
        message: GENERIC_ERROR,
      });
      expect(harness.root.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['nonexistent', 'private', 'foreign-tenant'])(
    'uses the generic unavailable path for a %s ID without writes or a global probe',
    async () => {
      const harness = createHarness({ boundIds: [] });

      await expect(
        harness.service.create({
          name: 'Unavailable product',
          supportedCatalogPriceListIds: [LIST_A],
        }),
      ).rejects.toMatchObject({
        name: 'InvalidArgumentError',
        code: 'INVALID_ARGUMENT',
        message: GENERIC_ERROR,
      });
      expect(harness.tx.globalPriceList.findMany).not.toHaveBeenCalled();
      expect(harness.tx.product.create).not.toHaveBeenCalled();
      expect(
        harness.tx.productCatalogPriceList.createMany,
      ).not.toHaveBeenCalled();
      expect(harness.committed()).toEqual({ products: [], joins: [] });
      expect(harness.buildFullResponse).not.toHaveBeenCalled();
    },
  );

  it('rolls back the product when join insertion fails and does not build a response', async () => {
    const joinError = new Error('join insert failed');
    const harness = createHarness({ boundIds: [LIST_A], joinError });

    await expect(
      harness.service.create({
        name: 'Rollback product',
        supportedCatalogPriceListIds: [LIST_A],
      }),
    ).rejects.toBe(joinError);

    expect(harness.events).toEqual([
      'binding-query',
      'product-create',
      'global-list-query',
      'join-create',
    ]);
    expect(harness.committed()).toEqual({ products: [], joins: [] });
    expect(harness.buildFullResponse).not.toHaveBeenCalled();
  });
});
