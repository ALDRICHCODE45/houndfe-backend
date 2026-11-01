import {
  CatalogPublishMode,
  CatalogStockPresentation,
  Prisma,
} from '@prisma/client';
import { ProductsService } from './products.service';
import type { UpdateVariantDto } from './dto/variant.dto';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';

const productId = 'product';
const variantId = 'variant';
const tenantId = 'tenant';
function setup() {
  const row = {
    id: variantId,
    productId,
    tenantId,
    name: 'Fresh',
    option: null,
    value: null,
    sku: 'SKU',
    barcode: 'BAR',
    quantity: 10,
    minQuantity: 2,
    purchaseNetCostCents: null as number | null,
    catalogPublishMode: CatalogPublishMode.INHERIT,
    onlineStockPresentation: null as CatalogStockPresentation | null,
    onlineStockPresentationCustomQty: null as number | null,
    product: { useStock: true },
  };
  let inside = false;
  let rearms = 0;
  const events: string[] = [];
  const record = (name: string) =>
    events.push(`${inside ? 'tx' : 'root'}:${name}`);
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('lifecycle');
      expect(inside).toBe(true);
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn<Promise<{ id: string }[]>, [Prisma.Sql]>(() => {
      record('gate');
      return Promise.resolve([{ id: productId }]);
    }),
    variant: {
      findFirst: jest.fn<Promise<typeof row | null>, [unknown]>(() => {
        record('read');
        return Promise.resolve(row);
      }),
      update: jest.fn(({ data }: { data: object; where: object }) => {
        record('update');
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      }),
    },
  };
  const root = {
    variant: {
      findFirst: jest.fn(() => {
        record('stale-read');
        return Promise.resolve({ ...row, name: 'Stale' });
      }),
    },
  };
  const repo = {
    isSkuTaken: jest.fn<Promise<boolean>, [string, object]>(() => {
      record('sku');
      return Promise.resolve(false);
    }),
    isBarcodeTaken: jest.fn<Promise<boolean>, [string, object]>(() => {
      record('barcode');
      return Promise.resolve(false);
    }),
    rearmAlertAfterEdit: jest.fn<Promise<void>, [object]>(() => {
      record('rearm');
      rearms++;
      return Promise.resolve();
    }),
  };
  const tenant = {
    getTenantId: () => tenantId,
    getClient: () => (inside ? tx : root),
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      if (inside) return work();
      const before = structuredClone(row);
      const oldRearms = rearms;
      events.push('begin');
      inside = true;
      try {
        const result = await work();
        events.push('commit');
        return result;
      } catch (error) {
        Object.assign(row, before);
        rearms = oldRearms;
        events.push('rollback');
        throw error;
      } finally {
        inside = false;
      }
    }),
  };
  type Args = ConstructorParameters<typeof ProductsService>;
  const service = new ProductsService(
    repo as unknown as Args[0],
    root as unknown as Args[1],
    {} as Args[2],
    tenant as unknown as Args[3],
    {} as Args[4],
  );
  const responseOwner = service as unknown as {
    enrichVariantCostResponse: (value: typeof row) => typeof row;
  };
  const original = responseOwner.enrichVariantCostResponse;
  const enrich = jest
    .spyOn(responseOwner, 'enrichVariantCostResponse')
    .mockImplementation((value) => {
      record('enrich');
      return original(value);
    });
  return {
    service,
    row,
    tx,
    root,
    repo,
    tenant,
    events,
    enrich,
    snapshot: () => ({ row: structuredClone(row), rearms }),
  };
}

it('takes the qualified parent gate before any read, uniqueness check, update or rearm', async () => {
  const s = setup();
  const result = await s.service.updateVariant(productId, variantId, {
    sku: ' sku ',
    barcode: ' bar ',
    quantity: 9,
  });
  expect(s.events).toEqual([
    'begin',
    'tx:lifecycle',
    'tx:gate',
    'tx:read',
    'tx:sku',
    'tx:barcode',
    'tx:update',
    'tx:rearm',
    'tx:enrich',
    'commit',
  ]);
  expect(s.tx.$executeRaw).toHaveBeenCalledTimes(1);
  expect(s.tx.$executeRaw.mock.calls[0]).toHaveLength(1);
  expect(s.tx.$executeRaw.mock.calls[0][0].join('')).toBe(
    'LOCK TABLE "global_price_lists" IN SHARE MODE',
  );
  const query = s.tx.$queryRaw.mock.calls[0][0];
  expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
    'SELECT "id" FROM "products" WHERE "tenantId" = ? AND "id" = ? FOR UPDATE',
  );
  expect(query.values).toEqual([tenantId, productId]);
  expect(s.tx.variant.findFirst).toHaveBeenCalledWith({
    where: { id: variantId, productId, tenantId },
    include: { product: { select: { useStock: true } } },
  });
  expect(s.tx.variant.update).toHaveBeenCalledWith({
    where: { id: variantId, productId, tenantId },
    data: { sku: 'SKU', barcode: 'bar', quantity: 9 },
  });
  expect(s.repo.isSkuTaken).toHaveBeenCalledWith(' sku ', { variantId });
  expect(s.repo.isBarcodeTaken).toHaveBeenCalledWith(' bar ', { variantId });
  expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledWith({
    productId,
    variantId,
  });
  expect(s.root.variant.findFirst).not.toHaveBeenCalled();
  expect(s.tenant.runInTransaction).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    ...s.row,
    sku: 'SKU',
    barcode: 'bar',
    quantity: 9,
    purchaseNetCostDecimal: null,
  });
});

it.each([
  'missing-parent',
  'foreign-parent',
  'missing-variant',
  'foreign-variant',
])('rejects %s without mutation', async (mode) => {
  const s = setup();
  if (mode.endsWith('parent')) s.tx.$queryRaw.mockResolvedValue([]);
  else s.tx.variant.findFirst.mockResolvedValue(null);
  const target = mode.startsWith('foreign') ? 'foreign-product' : productId;
  await expect(
    s.service.updateVariant(target, variantId, { quantity: 2 }),
  ).rejects.toEqual(new EntityNotFoundError('Variant', variantId));
  expect(s.tx.$queryRaw.mock.calls[0][0].values).toEqual([tenantId, target]);
  if (mode.endsWith('parent'))
    expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
  else
    expect(s.tx.variant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: variantId, productId: target, tenantId },
      }),
    );
  expect(s.tx.variant.update).not.toHaveBeenCalled();
  expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  expect(s.events.at(-1)).toBe('rollback');
});

it.each([
  'lifecycle',
  'gate',
  'read',
  'sku',
  'barcode',
  'update',
  'rearm',
  'enrich',
])(
  'propagates %s failure and prevents subsequent operations',
  async (stage) => {
    const s = setup();
    const before = s.snapshot();
    const error = new Error(`${stage} failed`);
    const method = {
      lifecycle: s.tx.$executeRaw,
      gate: s.tx.$queryRaw,
      read: s.tx.variant.findFirst,
      sku: s.repo.isSkuTaken,
      barcode: s.repo.isBarcodeTaken,
      update: s.tx.variant.update,
      rearm: s.repo.rearmAlertAfterEdit,
    }[stage]!;
    if (stage === 'enrich')
      s.enrich.mockImplementationOnce(() => {
        throw error;
      });
    else method.mockRejectedValue(error);
    await expect(
      s.service.updateVariant(productId, variantId, {
        sku: 'SKU',
        barcode: 'BAR',
        quantity: 9,
      }),
    ).rejects.toBe(error);
    expect(s.snapshot()).toEqual(before);
    expect(s.events.at(-1)).toBe('rollback');
    expect(s.events).not.toContain('commit');
    if (stage === 'lifecycle') {
      expect(s.events).toEqual(['begin', 'rollback']);
      expect(s.tx.$queryRaw).not.toHaveBeenCalled();
      expect(s.enrich).not.toHaveBeenCalled();
    }
    expect(s.tx.variant.update).toHaveBeenCalledTimes(
      ['update', 'rearm', 'enrich'].includes(stage) ? 1 : 0,
    );
    expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledTimes(
      ['rearm', 'enrich'].includes(stage) ? 1 : 0,
    );
  },
);

it.each(['sku', 'barcode'] as const)(
  'keeps %s conflicts after the gate with no writes',
  async (key) => {
    const s = setup();
    (key === 'sku'
      ? s.repo.isSkuTaken
      : s.repo.isBarcodeTaken
    ).mockResolvedValue(true);
    await expect(
      s.service.updateVariant(productId, variantId, { [key]: 'TAKEN' }),
    ).rejects.toEqual(
      new EntityAlreadyExistsError(key === 'sku' ? 'SKU' : 'Barcode', 'TAKEN'),
    );
    expect(s.events.slice(0, 4)).toEqual([
      'begin',
      'tx:lifecycle',
      'tx:gate',
      'tx:read',
    ]);
    expect(s.tx.variant.update).not.toHaveBeenCalled();
    expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  },
);

it('uses fresh post-gate parent stock and presentation when merging partial input', async () => {
  const s = setup();
  s.tx.$queryRaw.mockImplementation(() => {
    s.events.push('tx:gate');
    s.row.product.useStock = false;
    s.row.onlineStockPresentation = CatalogStockPresentation.CUSTOM_QUANTITY;
    s.row.onlineStockPresentationCustomQty = 4;
    return Promise.resolve([{ id: productId }]);
  });
  const result = await s.service.updateVariant(productId, variantId, {
    onlineStockPresentationCustomQty: 8,
    minQuantity: 3,
    name: ' New ',
  });
  expect(result).toMatchObject({
    name: 'New',
    minQuantity: 0,
    onlineStockPresentation: CatalogStockPresentation.CUSTOM_QUANTITY,
    onlineStockPresentationCustomQty: 8,
  });
  expect(s.repo.rearmAlertAfterEdit).toHaveBeenCalledTimes(1);
  expect(s.root.variant.findFirst).not.toHaveBeenCalled();
});

it('rejects freshly invalid merged presentation without writes or rearm', async () => {
  const s = setup();
  await expect(
    s.service.updateVariant(productId, variantId, {
      onlineStockPresentationCustomQty: 5,
    }),
  ).rejects.toBeInstanceOf(InvalidArgumentError);
  expect(s.events).toEqual([
    'begin',
    'tx:lifecycle',
    'tx:gate',
    'tx:read',
    'rollback',
  ]);
  expect(s.tx.variant.update).not.toHaveBeenCalled();
  expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
});

it.each([
  CatalogPublishMode.ON,
  CatalogPublishMode.OFF,
  CatalogPublishMode.INHERIT,
  undefined,
])('coordinates mode %p with mixed stock edits', async (catalogPublishMode) => {
  const s = setup();
  const dto: UpdateVariantDto = {
    quantity: 6,
    minQuantity: 1,
    catalogPublishMode,
  };
  expect(
    await s.service.updateVariant(productId, variantId, dto),
  ).toMatchObject({
    catalogPublishMode: catalogPublishMode ?? CatalogPublishMode.INHERIT,
    quantity: 6,
    minQuantity: 1,
  });
  expect(s.events).toEqual([
    'begin',
    'tx:lifecycle',
    'tx:gate',
    'tx:read',
    'tx:update',
    'tx:rearm',
    'tx:enrich',
    'commit',
  ]);
  expect(
    Object.hasOwn(
      s.tx.variant.update.mock.calls[0][0].data,
      'catalogPublishMode',
    ),
  ).toBe(catalogPublishMode !== undefined);
});

it.each([null, 0, 1234])(
  'preserves cost %p and does not rearm non-stock edits',
  async (purchaseNetCostCents) => {
    const s = setup();
    // @IsOptional admits null for these wire fields despite the narrower DTO type.
    const dto = {
      purchaseNetCostCents,
      option: ' Size ',
      value: ' Large ',
      sku: null,
      barcode: null,
    } as unknown as UpdateVariantDto;
    const result = await s.service.updateVariant(productId, variantId, dto);
    expect(result).toMatchObject({
      name: 'Large',
      option: 'Size',
      value: 'Large',
      sku: null,
      barcode: null,
      purchaseNetCostCents,
      purchaseNetCostDecimal:
        purchaseNetCostCents === null ? null : purchaseNetCostCents / 100,
    });
    expect(s.events).toEqual([
      'begin',
      'tx:lifecycle',
      'tx:gate',
      'tx:read',
      'tx:update',
      'tx:enrich',
      'commit',
    ]);
    expect(s.repo.isSkuTaken).not.toHaveBeenCalled();
    expect(s.repo.isBarcodeTaken).not.toHaveBeenCalled();
    expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
  },
);

it('awaits lifecycle before observations and merges fresh released state', async () => {
  const s = setup();
  let release!: () => void;
  s.tx.$executeRaw.mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        s.events.push('tx:lifecycle');
        release = () => resolve(0);
      }),
  );
  const before = s.snapshot();
  const result = s.service.updateVariant(productId, variantId, {
    value: ' Large ',
  });
  try {
    expect(s.events).toEqual(['begin', 'tx:lifecycle']);
    expect(s.tx.$queryRaw).not.toHaveBeenCalled();
    expect(s.tx.variant.findFirst).not.toHaveBeenCalled();
    expect(s.repo.isSkuTaken).not.toHaveBeenCalled();
    expect(s.repo.isBarcodeTaken).not.toHaveBeenCalled();
    expect(s.tx.variant.update).not.toHaveBeenCalled();
    expect(s.repo.rearmAlertAfterEdit).not.toHaveBeenCalled();
    expect(s.enrich).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(before);
    Object.assign(s.row, { option: 'Size', purchaseNetCostCents: 1234 });
  } finally {
    release?.();
    await result;
  }
  await expect(result).resolves.toEqual({
    ...before.row,
    option: 'Size',
    value: 'Large',
    name: 'Large',
    purchaseNetCostCents: 1234,
    purchaseNetCostDecimal: 12.34,
  });
  expect(s.events.slice(-2)).toEqual(['tx:enrich', 'commit']);
});
it.each([false, true])(
  'keeps repeated updates under ambient ownership, rollback=%s',
  async (rollback) => {
    const s = setup();
    const before = s.snapshot();
    const abort = new Error('outer');
    const result = s.tenant.runInTransaction(async () => {
      await expect(
        s.service.updateVariant(productId, variantId, {
          quantity: 7,
          purchaseNetCostCents: 0,
        }),
      ).resolves.toEqual({
        ...before.row,
        quantity: 7,
        purchaseNetCostCents: 0,
        purchaseNetCostDecimal: 0,
      });
      await expect(
        s.service.updateVariant(productId, variantId, { name: 'Next' }),
      ).resolves.toEqual({
        ...before.row,
        name: 'Next',
        quantity: 7,
        purchaseNetCostCents: 0,
        purchaseNetCostDecimal: 0,
      });
      expect(s.tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
        'LOCK TABLE "global_price_lists" IN SHARE MODE',
        'LOCK TABLE "global_price_lists" IN SHARE MODE',
      ]);
      expect(s.events.filter((e) => e === 'begin')).toHaveLength(1);
      expect(s.events).not.toContain('commit');
      expect(s.events.filter((e) => e === 'tx:enrich')).toHaveLength(2);
      expect(s.snapshot().rearms).toBe(1);
      if (rollback) throw abort;
    });
    if (rollback) {
      await expect(result).rejects.toBe(abort);
      expect(s.snapshot()).toEqual(before);
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(s.snapshot()).toEqual({
        row: {
          ...before.row,
          name: 'Next',
          quantity: 7,
          purchaseNetCostCents: 0,
        },
        rearms: 1,
      });
    }
  },
);
